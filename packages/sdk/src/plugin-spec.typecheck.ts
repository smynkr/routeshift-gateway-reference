import type { PluginId, PluginSpec, PluginWarning } from './index';

const webPlugin: PluginSpec = { id: 'web', required: true, max_results: 5 };
const fileParserPlugin: PluginSpec = { id: 'file-parser' };
const pluginId: PluginId = 'web';
const warning: PluginWarning = {
  plugin: 'web',
  code: 'plugin_backend_not_configured',
  reason: 'No backend is configured',
  message: 'Web search was skipped',
};

void webPlugin;
void fileParserPlugin;
void pluginId;
void warning;

// @ts-expect-error PluginSpec accepts only the proxy-supported plugin ids.
const invalidPlugin: PluginSpec = { id: 'browser' };
void invalidPlugin;
