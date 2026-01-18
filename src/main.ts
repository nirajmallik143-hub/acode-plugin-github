import plugin from '../plugin.json';
import { getGitHubSettings, initializeGitHubPlugin } from './github';
import { Disposable } from './utils';

if (window.acode) {
  let disposable: Disposable | undefined;
  acode.setPluginInit(
    plugin.id,
    async (baseUrl: string, page, options) => {
      if (!baseUrl.endsWith('/')) baseUrl += '/';

      disposable = initializeGitHubPlugin(baseUrl, options);
    },
    getGitHubSettings()
  );
  acode.setPluginUnmount(plugin.id, () => disposable?.dispose());
}