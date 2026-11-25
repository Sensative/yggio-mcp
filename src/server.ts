import {McpServer} from '@modelcontextprotocol/server';
import type {Config} from './config.js';
import {YggioClient} from './client.js';
import {registerTools} from './tools.js';
import {spec} from './spec.js';

export const VERSION = '0.2.0';

export const instructions = (config: Config) => `This server connects to the Yggio IoT platform at ${config.baseUrl} as one logged-in user.

- Yggio calls devices "iotnodes". Start with yggio_find_devices / yggio_get_device; history is in yggio_device_measurements + yggio_device_history.
- Anything else (device groups, organizations, rules, reports, dashboards, locations, connectors, users...) goes through
  yggio_search_api -> yggio_describe_endpoint -> yggio_api_get${config.readOnly ? '' : ' / yggio_api_write'}.
- Times in the API are unix milliseconds; stats \`distance\` is in seconds.
- Ids are MongoDB ObjectId strings (24 hex characters).
${config.readOnly
    ? '- This server is read-only: no tool can change data in Yggio.'
    : '- yggio_api_write changes real data. Say what you are about to change and get the user\'s go-ahead before deletes or bulk changes.'}
- API reference: ${spec.info.source ?? 'bundled OpenAPI spec'}.`;

export const createServerFactory = (config: Config, client = new YggioClient(config)) =>
  // The factory runs per connection; the client (and its login) is shared.
  () => {
    const server = new McpServer(
      {name: 'yggio', title: 'Yggio', version: VERSION},
      {capabilities: {tools: {}}, instructions: instructions(config)},
    );
    registerTools(server, config, client);
    return server;
  };

export {YggioClient};
