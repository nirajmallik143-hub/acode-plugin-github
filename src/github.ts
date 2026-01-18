import { Octokit } from '@octokit/rest';
import { GithubServer } from './server';
import { Credentials, CredentialsProvider, API as GitApi, GitErrorCodes, GitExtension, PushErrorHandler, Remote, RemoteSource, RemoteSourceProvider, Repository } from './typings/git';
import { item, showDialogMessage } from './ui/dialog';
import { HintItem, InputHint, showInputHints } from './ui/hints';
import { uriToPath } from './uri';
import { Disposable, dispose, EmptyDisposable, toDisposable } from './utils';

const appSettings = acode.require('settings');
const Loader = acode.require('loader');
const fsOperation = acode.require('fsOperation');
const Url = acode.require('Url');

type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T;

export interface GitHubAuthSession {
  readonly accessToken: string;
  readonly account: GitHubAccountInfo;
}

export interface GitHubAccountInfo {
  readonly id: string;
  readonly label?: string;
}

interface GitHubAuth {
  getSession(): Promise<GitHubAuthSession | undefined>;
  createSession(): Promise<GitHubAuthSession>;
}

const defaultSettings: Acode.IGithubSettings = {
  gitAuthentication: true,
  gitProtocol: 'https'
}

async function confirmCreateSession(): Promise<boolean> {
  const content = `
    <div style="width: 100%; display: flex; justify-content: center; align-items: center; flex-direction: column; box-sizing: border-box;">
      <!-- GitHub Icon -->
      <div style="margin-bottom: 20px;">
        <span class="icon github" style="max-width: 50px; width: 50px; height: 50px; background-size: 50px;"></span>
      </div>

      <!-- Title -->
      <div style="font-size: 24px; font-weight: 600; margin-bottom: 8px; text-align: center;">
        Create GitHub Token (PAT)
      </div>

      <!-- Description -->
      <div style="font-size: 14px; margin-bottom: 24px; text-align: center;">
        Connect your account to work with private repositories and perform Git operations that need authentication
      </div>
    </div>
  `;
  const createToken = item('Create Token');
  const result = await showDialogMessage('', content, createToken);
  return result === createToken;
}

class GithubCredentialProvider implements CredentialsProvider {

  async getCredentials(host: string): Promise<Credentials | undefined> {
    if (!/github\.com/i.test(host)) {
      return;
    }

    try {
      let session = await this.auth.getSession();
      if (!session) {
        const confirmation = await confirmCreateSession();

        if (!confirmation) {
          return;
        }

        session = await this.auth.createSession();
      }

      return {
        username: session.account.id,
        password: session.accessToken
      };
    } catch (err) {
      return undefined;
    }
  }

  constructor(private readonly auth: GitHubAuth) { }
}

class GithubCredentialProviderManager {

  private providerDisposable: Disposable = EmptyDisposable;
  private readonly disposable: Disposable;

  private _enabled = false;
  private set enabled(enabled: boolean) {
    if (this._enabled === enabled) {
      return;
    }

    if (enabled) {
      this.providerDisposable = this.git.registerCredentialsProvider(new GithubCredentialProvider(this.auth));
    } else {
      this.providerDisposable.dispose();
    }
  }

  constructor(private readonly git: GitApi, private readonly auth: GitHubAuth) {
    const onConfigurationChange = () => {
      this.refresh();
    }
    appSettings.on('update:dikidjatar.github', onConfigurationChange);
    this.disposable = toDisposable(() => {
      appSettings.off('update:dikidjatar.github', onConfigurationChange);
    });

    this.refresh();
  }

  private refresh(): void {
    const config = appSettings.get('dikidjatar.github');
    const enabled = config?.gitAuthentication === true;
    this.enabled = enabled;
  }

  dispose(): void {
    this.enabled = false;
    this.disposable.dispose();
  }
}

function sanitizeRepositoryName(value: string): string {
  return value.trim().replace(/[^a-z0-9_.]/ig, '-');
}

function getHint<T extends HintItem>(inputHint: InputHint<T>): Promise<T | undefined> {
  return Promise.race<T | undefined>([
    new Promise(c => inputHint.onDidSelect(item => c(item))),
    new Promise<undefined>(c => inputHint.onDidHide(() => c(undefined)))
  ]);
}

export function getRepositoryFromUrl(url: string): { owner: string; repo: string } | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/i.exec(url)
    || /^git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/i.exec(url);
  return match ? { owner: match[1], repo: match[2] } : undefined;
}

export function getRepositoryFromQuery(query: string): { owner: string; repo: string } | undefined {
  const match = /^([^/]+)\/([^/]+)$/i.exec(query);
  return match ? { owner: match[1], repo: match[2] } : undefined;
}

type RemoteSourceResponse = {
  readonly full_name: string;
  readonly description: string | null;
  readonly stargazers_count: number;
  readonly clone_url: string;
  readonly ssh_url: string;
};

function asRemoteSource(raw: RemoteSourceResponse): RemoteSource {
  const protocol = appSettings.get('dikidjatar.github')?.gitProtocol;
  return {
    name: `${raw.full_name}`,
    icon: 'github',
    description: `${raw.stargazers_count > 0 ? `★ ${raw.stargazers_count}` : ''
      }`,
    detail: raw.description || undefined,
    url: protocol === 'ssh' ? raw.ssh_url : raw.clone_url
  };
}

class KeyChain {

  private tokenFileUrl: string;

  constructor(private readonly serviceId: string) {
    this.tokenFileUrl = Url.join(DATA_STORAGE, `.${serviceId}.token`);
  }

  async setToken(token: string): Promise<void> {
    try {
      if (!await fsOperation(this.tokenFileUrl).exists()) {
        await fsOperation(DATA_STORAGE).createFile(`.${this.serviceId}.token`, token);
      } else {
        await fsOperation(this.tokenFileUrl).writeFile(token);
      }
    } catch (err) {
      console.error('setting token failed:', err);
    }
  }

  async getToken(): Promise<string | null | undefined> {
    try {
      return await fsOperation(this.tokenFileUrl).readFile('utf-8');
    } catch (err) {
      console.error('getting token failed:', err);
    }
  }

  async deleteToken(): Promise<void> {
    try {
      return await fsOperation(this.tokenFileUrl).delete();
    } catch (err) {
      console.log('deleting token failed:', err);
    }
  }
}

export class GitHub implements GitHubAuth, RemoteSourceProvider, PushErrorHandler {

  readonly icon: string = 'github';
  readonly name: string = 'GitHub';
  readonly supportsQuery: boolean = true;
  private userReposCache: RemoteSource[] = [];

  private readonly keyChain: KeyChain;
  private readonly githubServer: GithubServer;
  private _session: GitHubAuthSession | undefined;
  private readonly SCOPES = ['repo', 'workflow', 'user:email', 'read:user'];
  private readonly disposables: Disposable[] = [];

  constructor(private readonly git: GitApi) {
    if (!appSettings.value['dikidjatar.github']) {
      appSettings.value['dikidjatar.github'] = defaultSettings;
      appSettings.update({}, true, true);
    }
    this.disposables.push(toDisposable(() => {
      appSettings.update({ 'dikidjatar.github': undefined }, false, true);
    }));
    this.keyChain = new KeyChain('github.auth');
    this.githubServer = new GithubServer();
    this.disposables.push(new GithubCredentialProviderManager(this.git, this));
    this.disposables.push(this.git.registerPushErrorHandler(this));
    this.disposables.push(this.git.registerRemoteSourceProvider(this));

    this.registerCommand({
      name: 'github.publish',
      description: 'Publish To GitHub',
      exec: this.publishRepository.bind(this)
    });
  }

  async getSession(): Promise<GitHubAuthSession | undefined> {
    if (!this._session) {
      await this.loadSession();
    }
    return this._session;
  }

  private async loadSession(): Promise<void> {
    try {
      console.log('Loading session from keychain...');
      const storedSession = await this.keyChain.getToken();

      if (!storedSession) {
        this._session = undefined;
        return;
      }

      try {
        const session = JSON.parse(storedSession) as GitHubAuthSession;

        // Verify the token is still valid
        try {
          await this.githubServer.getUserInfo(session.accessToken);
          this._session = session;
          console.log('Session loaded and verified');
        } catch (e: any) {
          console.error('Session token is invalid:', e.message);
          await this.keyChain.deleteToken();
          this._session = undefined;
        }
      } catch (err) {
        console.error('Error parsing session:', err);
        await this.keyChain.deleteToken();
        this._session = undefined;
      }
    } catch (err) {
      console.error('Error loading session:', err);
      this._session = undefined;
    }
  }

  private async saveSession(session: GitHubAuthSession): Promise<void> {
    this._session = session;
    await this.keyChain.setToken(JSON.stringify(session));
  }

  async createSession(): Promise<GitHubAuthSession> {
    try {
      const scopeString = this.SCOPES.join(' ');
      const token = await this.githubServer.login(scopeString);
      const userInfo = await this.githubServer.getUserInfo(token);

      const session: GitHubAuthSession = {
        accessToken: token,
        account: { label: userInfo.accountName, id: userInfo.id }
      };

      await this.saveSession(session);
      return session;
    } catch (err: any) {
      if (err === 'Cancelled' || err?.message === 'Cancelled') {
        throw err;
      }

      acode.pushNotification('GitHub', `Failed to create session: ${err.message}`, { type: 'error', icon: 'github' });
      console.error(err);
      throw err;
    }
  }

  async handlePushError(repository: Repository, remote: Remote, refspec: string, error: Error & { stderr: string, gitErrorCode: GitErrorCodes; }): Promise<boolean> {
    if (error.gitErrorCode !== GitErrorCodes.PermissionDenied && error.gitErrorCode !== GitErrorCodes.PushRejected) {
      return false;
    }

    const remoteUrl = remote.pushUrl;
    if (!remoteUrl) {
      return false;
    }

    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^\/]+)\/([^\/.]+)/i.exec(remoteUrl);
    if (!match) {
      return false;
    }

    if (/^:/.test(refspec)) {
      return false;
    }

    const [, owner, repo] = match;

    if (error.gitErrorCode === GitErrorCodes.PermissionDenied) {
      await this.handlePermissionDeniedError(repository, remote, refspec, owner, repo);
      return true;
    }

    if (/GH009: Secrets detected!/i.test(error.stderr)) {
      acode.alert('WARNING', `Your push to "${owner}/${repo}" was rejected by GitHub because push protection is enabled and one or more secrets were detected.`);
      return true;
    }

    console.log('[GitHub][pushErrorHandler] handler: None, error:', error);
    return false;
  }

  private async handlePermissionDeniedError(repository: Repository, remote: Remote, refspec: string, owner: string, repo: string): Promise<void> {
    const askFork = `You don\'t have permissions to push to "${owner}/${repo}" on GitHub. Would you like to create a fork and push to it instead?`;
    const answer = await acode.confirm('WARNING', askFork);
    if (!answer) {
      return;
    }

    const match = /^([^:]*):([^:]*)$/.exec(refspec);
    const localName = match ? match[1] : refspec;
    let remoteName = match ? match[2] : refspec;

    const loader = Loader.create('Create GitHub fork', `Forking: "${owner}/${repo}"`);
    const octokit = await this.getOctokit();

    type CreateForkResponseData = Awaited<ReturnType<typeof octokit.repos.createFork>>['data'];

    let ghRepository: CreateForkResponseData;
    try {
      const resp = await octokit.repos.createFork({ owner, repo });
      ghRepository = resp.data;

      loader.setMessage('Pushing changes...');

      await repository.renameRemote(remote.name, 'upstream');
      const protocol = appSettings.get('dikidjatar.github')?.gitProtocol;
      const remoteUrl = protocol === 'ssh' ? ghRepository.ssh_url : ghRepository.clone_url;
      await repository.addRemote('origin', remoteUrl);

      try {
        await repository.fetch('origin', remoteName);
        await repository.setBranchUpstream(localName, `origin/${remoteName}`);
      } catch (err) {
        // noop
      }

      await repository.push('origin', localName, true);
      loader.destroy();
    } catch (err) {
      console.error('Fork creation error:', err);
      loader.destroy();
      throw err;
    }

    (async () => {
      const openOnGitHub = item('Open on GitHub');
      const createPR = item('Create PR');
      const action = await showDialogMessage('INFO', `The fork "${ghRepository.full_name}" was successfully created on GitHub.`, openOnGitHub, createPR);

      if (action === openOnGitHub) {
        system.openInBrowser(ghRepository.html_url);
      } else if (action === createPR) {
        try {
          Loader.create('LOADING', 'Creating GitHub Pull Request...');
          let title = `Update ${remoteName}`;
          const head = repository.state.HEAD?.name;

          let body: string | undefined;

          if (head) {
            const commit = await repository.getCommit(head);
            title = commit.message.split('\n')[0];
            body = commit.message.slice(title.length + 1).trim();
          }

          const { data: pr } = await octokit.pulls.create({
            owner,
            repo,
            title,
            body,
            head: `${ghRepository.owner.login}:${remoteName}`,
            base: ghRepository.default_branch
          });

          await repository.setConfig(`branch.${localName}.remote`, 'upstream');
          await repository.setConfig(`branch.${localName}.merge`, `refs/heads/${remoteName}`);
          await repository.setConfig(`branch.${localName}.github-pr-owner-number`, `${owner}#${repo}#${pr.number}`);

          Loader.destroy();

          const confirm = await acode.confirm('INFO', `The PR "${owner}/${repo}#${pr.number}" was successfully created on GitHub. Would you like to open it?`);

          if (confirm) {
            system.openInBrowser(pr.html_url);
          }
        } catch (err) {
          Loader.destroy();
          throw err;
        }
      }
    })();
  }

  async publishRepository(repository?: Repository): Promise<void> {
    if (!addedFolder.length) {
      return;
    }

    let folder: string;

    if (repository) {
      folder = repository.rootUri;
    } else if (this.git.repositories.length === 1) {
      repository = this.git.repositories[0];
      folder = repository.rootUri;
    } else if (addedFolder.length === 1) {
      folder = uriToPath(addedFolder[0].url);
    } else {
      const hints = addedFolder.map(folder => ({ label: folder.title, folder }));
      const hint = await showInputHints(hints, { placeholder: 'Select a folder to publish to GitHub' });

      if (!hint) {
        return;
      }

      folder = uriToPath(hint.folder.url);
    }

    let inputHint = new InputHint<HintItem & { repo?: string, auth?: 'https' | 'ssh', isPrivate?: boolean }>();
    inputHint.ignoreFocusOut = true;

    inputHint.placeholder = 'Repository Name';
    inputHint.value = Url.basename(folder)!;
    inputHint.loading = true;

    let owner: string;
    let octokit: Octokit;
    try {
      octokit = await this.getOctokit();
      const user = await octokit.users.getAuthenticated({});
      owner = user.data.login;
    } catch (err: any) {
      console.error(err);
      acode.pushNotification('ERROR', err.message, { type: 'error', icon: 'error' });
      inputHint.dispose();
      return;
    }

    inputHint.loading = false;

    let repo: string | undefined;
    let isPrivate: boolean;

    const onDidChangeValue = async () => {
      const sanitizedRepo = sanitizeRepositoryName(inputHint.value);

      if (!sanitizedRepo) {
        inputHint.items = [];
      } else {
        inputHint.items = [
          { label: 'Publish to GitHub private repository', icon: 'repo', description: `${owner}/${sanitizedRepo}`, repo: sanitizedRepo, isPrivate: true },
          { label: 'Publish to GitHub public repository', icon: 'repo', description: `${owner}/${sanitizedRepo}`, repo: sanitizedRepo, isPrivate: false }
        ];
      }
    }

    onDidChangeValue();

    while (true) {
      const listener = inputHint.onDidChangeValue(onDidChangeValue);
      const hint = await getHint(inputHint);
      listener.dispose();

      repo = hint?.repo;
      isPrivate = hint?.isPrivate ?? true;

      if (repo) {
        try {
          inputHint.loading = true;
          const fullName = `${owner}/${repo}`;
          const result = await octokit.repos.get({ owner, repo: repo });
          if (result.data.full_name.toLowerCase() !== fullName.toLowerCase()) {
            break;
          }
          inputHint.items = [{ label: 'GitHub repository already exists', icon: 'error', smallDescription: fullName }];
        } catch {
          break;
        } finally {
          inputHint.loading = false;
        }
      }
    }

    inputHint.dispose();

    if (!repo) {
      return;
    }

    const loader = Loader.create('Publish To GitHub', isPrivate ? 'Publishing to a private GitHub repository' : 'Publishing to a public GitHub repository');
    type CreateRepositoryResponseData = Awaited<ReturnType<typeof octokit.repos.createForAuthenticatedUser>>['data'];
    let createdGithubRepository: CreateRepositoryResponseData | undefined = undefined;

    try {
      const res = await octokit.repos.createForAuthenticatedUser({
        name: repo,
        private: isPrivate
      });
      createdGithubRepository = res.data;

      if (createdGithubRepository) {
        loader.setMessage('Creating first commit');

        if (!repository) {
          repository = await this.git.init(folder, { defaultBranch: createdGithubRepository.default_branch }) || undefined;

          if (!repository) {
            loader.destroy();
            return;
          }

          await repository.commit('first commit', { all: true });
        }

        loader.setMessage('Uploading files');
        const branch = await repository.getBranch('HEAD');
        const protocol = appSettings.get('dikidjatar.github')?.gitProtocol;
        const remoteUrl = protocol === 'ssh' ? createdGithubRepository.ssh_url : createdGithubRepository.clone_url;
        await repository.addRemote('origin', remoteUrl);
        await repository.push('origin', branch.name, true);
      }

      if (!createdGithubRepository) {
        return;
      }

      const openOnGitHub = await acode.confirm('INFO', `Successfully published the "${owner}/${repo}" repository to GitHub.`);
      if (openOnGitHub) {
        system.openInBrowser(createdGithubRepository.html_url);
      }
    } finally {
      loader.destroy();
    }
  }

  async getRemoteSources(query?: string): Promise<RemoteSource[]> {
    const octokit = await this.getOctokit();

    if (query) {
      const repository = getRepositoryFromUrl(query);

      if (repository) {
        const raw = await octokit.repos.get(repository);
        return [asRemoteSource(raw.data)];
      }
    }

    const all = await Promise.all([
      this.getQueryRemoteSources(octokit, query),
      this.getUserRemoteSources(octokit, query),
    ]);

    const map = new Map<string, RemoteSource>();

    for (const group of all) {
      for (const remoteSource of group) {
        map.set(remoteSource.name, remoteSource);
      }
    }

    return [...map.values()];
  }

  private async getUserRemoteSources(octokit: Octokit, query?: string): Promise<RemoteSource[]> {
    if (!query) {
      const user = await octokit.users.getAuthenticated({});
      const username = user.data.login;
      const res = await octokit.repos.listForAuthenticatedUser({ username, sort: 'updated', per_page: 100 });
      this.userReposCache = res.data.map(asRemoteSource);
    }

    return this.userReposCache;
  }

  private async getQueryRemoteSources(octokit: Octokit, query?: string): Promise<RemoteSource[]> {
    if (!query) {
      return [];
    }

    const repository = getRepositoryFromQuery(query);

    if (repository) {
      query = `user:${repository.owner}+${repository.repo}`;
    }

    query += ` fork:true`;

    const raw = await octokit.search.repos({ q: query, sort: 'stars' });
    return raw.data.items.map(asRemoteSource);
  }

  private _octokit: Promise<Octokit> | undefined;
  private async getOctokit(): Promise<Octokit> {
    if (!this._octokit) {
      this._octokit = this.getSession().then(async session => {
        if (!session) {
          const result = await confirmCreateSession();
          if (!result) {
            throw new Error('GitHub authentication required');
          }

          session = await this.createSession();
        }

        const token = session!.accessToken;
        const { Octokit } = await import('@octokit/rest');
        return new Octokit({
          userAgent: 'GitHub Acode',
          auth: `token ${token}`
        });
      }).then(null, async err => {
        this._octokit = undefined;
        throw err;
      });
    }

    return this._octokit;
  }

  private registerCommand(command: Ace.Command): void {
    editorManager.editor.commands.addCommand(command);
    this.disposables.push(toDisposable(() => {
      editorManager.editor.commands.removeCommand(command);
    }));
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

export function getGitHubSettings(): Acode.PluginSettings {
  const config = appSettings.get('dikidjatar.github') || defaultSettings;
  return {
    list: [
      {
        key: 'gitAuthentication',
        checkbox: config.gitAuthentication,
        text: 'Git Authentication',
        info: 'Controls whether to enable automatic GitHub authentication for git commands within Acode.'
      },
      {
        key: 'gitProtocol',
        value: config.gitProtocol,
        select: ['https', 'ssh'],
        text: 'GitHub Git Protocol',
        info: 'Controls which protocol is used to clone a GitHub repository'
      }
    ],
    cb: (key: string, value: unknown) => {
      const oldValue = appSettings.get('dikidjatar.github') || defaultSettings;
      appSettings.update({ 'dikidjatar.github': { ...oldValue, [key]: value } } as Partial<Acode.ISettings>, true, true);
    }
  }
}

export function initializeGitHubPlugin(baseUrl: string, options: Acode.PluginInitOptions): Disposable {
  let disposables: Disposable[] = [];

  let gitPlugin = acode.require('git') as GitExtension;

  const initialize = () => {
    const onDidChangeGitPluginEnablement = (enabled: boolean) => {
      if (enabled) {
        const gitAPI = gitPlugin.getAPI(1);
        disposables.push(new GitHub(gitAPI));
      } else {
        disposables = dispose(disposables);
      }
    };

    disposables.push(gitPlugin.onDidChangeEnablement(onDidChangeGitPluginEnablement));
    onDidChangeGitPluginEnablement(gitPlugin.enabled);
  }

  if (gitPlugin) {
    initialize();
  } else {
    if (acode.waitForPlugin) {
      acode.waitForPlugin('acode.plugin.version.control.gitpro')
        .then(() => {
          if (!gitPlugin && acode.require('git')) {
            gitPlugin = acode.require('git') as GitExtension;
            initialize();
          }
        }).catch(console.warn);
    } else {
      const startTime = Date.now();

      const pollGitPlugin = () => {
        if (!gitPlugin && acode.require('git')) {
          gitPlugin = acode.require('git') as GitExtension;
          initialize();
        } else if (Date.now() - startTime < 10000) {
          setTimeout(pollGitPlugin, 500);
        } else {
          console.warn('[GitHub] plugin did not load within 10 seconds');
        }
      };

      pollGitPlugin();
    }
  }

  return toDisposable(() => {
    disposables = dispose(disposables);
  });
}