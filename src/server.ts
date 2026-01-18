const confirm = acode.require('confirm');
const prompt = acode.require('prompt');

interface IFlowTriggerOptions {
  scopes: string;
  baseUrl: string;
  apiBaseUrl: string;
}

interface IFlow {
  trigger(options: IFlowTriggerOptions): Promise<string>;
}

class PatFlow implements IFlow {
  async trigger({ scopes, baseUrl, apiBaseUrl }: IFlowTriggerOptions): Promise<string> {
    const confirmation = await confirm('Continue to GitHub ', 'Continue to GitHub to create a Personal Access Token (PAT). To finish authenticating, navigate to GitHub to create a PAT then paste the PAT into the input box.');
    if (!confirmation) { throw new Error('User Cancelled'); }

    const description = `Acode Github Authentication (${scopes})`;
    const urlToOpen = `${baseUrl}/settings/tokens/new?description=${description}&scopes=${scopes.split(' ').join(',')}`;
    system.openInBrowser(urlToOpen);
    const token = await prompt('GitHub Personal Access Token', '', 'text', { placeholder: 'ghp_1a2b3c4...', required: true });
    if (!token) { throw new Error('User Cancelled'); }

    const tokenScopes = await this.getScopes(token, apiBaseUrl);
    const scopesList = scopes.split(' ');
    if (!scopesList.every(scope => {
      const included = tokenScopes.includes(scope);
      if (included || !scope.includes(':')) {
        return included;
      }

      return scope.split(':').some(splitScopes => {
        return tokenScopes.includes(splitScopes);
      });
    })) {
      throw new Error(`The provided token does not match the requested scopes: ${scopes}`);
    }

    return token;
  }

  private async getScopes(token: string, serverUrl: string): Promise<string[]> {
    try {
      console.log('Getting token scopes...');
      const result = await fetch(serverUrl, {
        headers: {
          Authorization: `token ${token}`,
          'User-Agent': `Acode (https://acode.app)`
        }
      });

      if (result.ok) {
        const scopes = result.headers.get('X-OAuth-Scopes');
        return scopes ? scopes.split(',').map(scope => scope.trim()) : [];
      } else {
        console.error(`Getting scopes failed: ${result.statusText}`);
        throw new Error(result.statusText);
      }
    } catch (err: any) {
      console.error(err.message);
      throw new Error('network error');
    }
  }
}

export class GithubServer {

  private readonly BASE_URL = 'https://github.com';
  private readonly API_BASE_URL = 'https://api.github.com';

  async login(scopes: string): Promise<string> {
    console.log(`Logging in for the following scopes: ${scopes}`);

    const flow = new PatFlow();
    return await flow.trigger({
      scopes,
      baseUrl: this.BASE_URL,
      apiBaseUrl: this.API_BASE_URL
    });
  }

  async getUserInfo(token: string): Promise<{ id: string; accountName: string; }> {
    let result;
    try {
      console.log('Getting user info...');
      result = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `token ${token}`,
          'User-Agent': `Acode (https://acode.app)`
        }
      });
    } catch (err) {
      console.error(err);
      throw new Error('network error');
    }

    if (result.ok) {
      try {
        const json = await result.json() as { id: number; login: string };
        console.log('Got account info!');
        return { id: `${json.id}`, accountName: json.login };
      } catch (e: any) {
        console.error(`Unexpected error parsing response from GitHub: ${e.message ?? e}`);
        throw e;
      }
    } else {
      let errorMessage = result.statusText;
      try {
        const json = await result.json();
        if (json.message) {
          errorMessage = json.message;
        }
      } catch { }
      console.error(`Getting account info failed: ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }
}