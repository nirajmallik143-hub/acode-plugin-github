declare namespace Acode {

  interface ISettings {
    "dikidjatar.github": IGithubSettings | undefined;
  }

  interface IGithubSettings {
    readonly gitAuthentication: boolean;
    readonly gitProtocol: 'ssh' | 'https';
  }
}