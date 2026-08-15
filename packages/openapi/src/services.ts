// Per-service document metadata for the public spec.
//
// This is the ONLY hand-written content in the generated documents; everything
// else is projected from the Zod registry. Servers follow the deployment
// contract in product/deployment/SECRETS_AND_KEYS.md: one public edge,
// `https://app.gtm-api.com/{service}/v4`, path-routed by the gateway on the id
// host. There are no per-service subdomains.
//
// The public document lists the PRODUCTION server and nothing else. Local
// Docker ports belong to the dev API, not to the contract we publish: a
// `http://localhost:...` entry here reaches the reference site and its
// playground, where it is at best noise and at worst a reader pointing their
// first call at a port that does not exist on their machine.

import type { ServiceId } from '@gtm/mcp-runtime/types';

export type PublicServiceId = Exclude<ServiceId, 'support'>;

export interface ServerEntry {
  url: string;
  description: string;
}

export interface ServiceMeta {
  title: string;
  summary: string;
  servers: ServerEntry[];
}

/** The services that have a public `/api` surface in the registry. */
export const PUBLIC_SERVICES: PublicServiceId[] = ['linkedin', 'id', 'orchestration'];

export const SERVICE_META: Record<PublicServiceId, ServiceMeta> = {
  linkedin: {
    title: 'GTM API public contract: gtm.service.linkedin',
    summary:
      'Connected LinkedIn accounts and everything driven through them: account health and smart limits, conversations and messages, the connection graph, outbound posting, scraping, profile and company enrichment, and the antidetect browsers that execute it all.',
    servers: [
      { url: 'https://app.gtm-api.com/linkedin/v4', description: 'Production, through the app.gtm-api.com gateway' },
    ],
  },
  id: {
    title: 'GTM API public contract: gtm.service.id',
    summary:
      'Identity, access and money: users, teams and members, API keys, OAuth clients and authorizations, billing products, subscriptions, transactions and payment methods, notifications, TLS certificates, observability and support requests.',
    servers: [
      { url: 'https://app.gtm-api.com/id/v4', description: 'Production, through the app.gtm-api.com gateway' },
    ],
  },
  orchestration: {
    title: 'GTM API public contract: gtm.service.orchestration',
    summary:
      'The cross-service execution plane: the platform-wide webhook registry and delivery log, plus mass actions (preview, commit, pace, pause, resume, canary) and their per-item child rows.',
    servers: [
      { url: 'https://app.gtm-api.com/orchestration/v4', description: 'Production, through the app.gtm-api.com gateway' },
    ],
  },
};

export const CONTACT = {
  name: 'GTM API',
  url: 'https://gtm-api.com',
  email: 'support@gtm-api.com',
};

export const LICENSE = {
  name: 'Proprietary',
  url: 'https://gtm-api.com/license',
};

/** Bumped by hand when the shape of the generated document changes. */
export const SPEC_VERSION = '1.0';
