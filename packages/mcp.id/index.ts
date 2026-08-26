import type { ToolPackage } from '@gtm/mcp-runtime/types';
import { usersTools } from './users/mcp-tools';
import { teamsTools } from './teams/mcp-tools';
import { teamMembersTools } from './team_members/mcp-tools';
import { sessionsTools } from './sessions/mcp-tools';
import { apiKeysTools } from './api_keys/mcp-tools';
import { oauthClientsTools } from './oauth_clients/mcp-tools';
import { oauthAuthorizationsTools } from './oauth_authorizations/mcp-tools';
import { billingProductsTools } from './billing_products/mcp-tools';
import { billingSubscriptionsTools } from './billing_subscriptions/mcp-tools';
import { billingTransactionsTools } from './billing_transactions/mcp-tools';
import { billingPaymentMethodsTools } from './billing_payment_methods/mcp-tools';
import { notificationsTools } from './notifications/mcp-tools';
import { supportRequestsTools } from './support_requests/mcp-tools';
import { sslCertificatesTools } from './ssl_certificates/mcp-tools';
import { accountSharesTools } from './account_shares/mcp-tools';

const pkg = (entity: string, tools: ToolPackage['tools']): ToolPackage => ({
  id: `mcp.id/${entity}`,
  service: 'id',
  entity,
  tools,
});

export const idPackages: ToolPackage[] = [
  pkg('users', usersTools),
  pkg('teams', teamsTools),
  pkg('team_members', teamMembersTools),
  pkg('sessions', sessionsTools),
  pkg('api_keys', apiKeysTools),
  pkg('oauth_clients', oauthClientsTools),
  pkg('oauth_authorizations', oauthAuthorizationsTools),
  pkg('billing_products', billingProductsTools),
  pkg('billing_subscriptions', billingSubscriptionsTools),
  pkg('billing_transactions', billingTransactionsTools),
  pkg('billing_payment_methods', billingPaymentMethodsTools),
  pkg('notifications', notificationsTools),
  pkg('support_requests', supportRequestsTools),
  pkg('ssl_certificates', sslCertificatesTools),
  pkg('account_shares', accountSharesTools),
];
