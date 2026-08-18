export interface SearchConsoleSite {
  siteUrl: string;
  permissionLevel: string;
}

const SITE_OWNER_PERMISSION = 'siteOwner';
const DOMAIN_PROPERTY_PREFIX = 'sc-domain:';

function parseHttpUrl(value: string, fieldName: string): URL {
  if (value !== value.trim() || !/^https?:\/\//i.test(value)) {
    throw new Error(`${fieldName} must be a fully qualified HTTP or HTTPS URL.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a fully qualified HTTP or HTTPS URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${fieldName} must use the HTTP or HTTPS scheme.`);
  }
  if (!url.hostname) {
    throw new Error(`${fieldName} must include a hostname.`);
  }
  if (url.username || url.password) {
    throw new Error(`${fieldName} must not include userinfo.`);
  }

  return url;
}

function parseDomainProperty(siteUrl: string): string {
  const domain = siteUrl.slice(DOMAIN_PROPERTY_PREFIX.length);
  if (!domain || /[/?#@:]/.test(domain)) {
    throw new Error('site_url is not a valid Search Console domain property.');
  }

  const parsed = parseHttpUrl(`https://${domain}`, 'site_url');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.port) {
    throw new Error('site_url is not a valid Search Console domain property.');
  }

  return parsed.hostname;
}

function normalizeSiteUrl(siteUrl: string): string {
  if (siteUrl.startsWith(DOMAIN_PROPERTY_PREFIX)) {
    return `${DOMAIN_PROPERTY_PREFIX}${parseDomainProperty(siteUrl)}`;
  }

  const parsed = parseHttpUrl(siteUrl, 'site_url');
  if (parsed.search || parsed.hash) {
    throw new Error('site_url must not include a query string or fragment.');
  }
  return parsed.href;
}

function isWithinUrlPrefix(target: URL, property: URL): boolean {
  if (target.origin !== property.origin) return false;

  const propertyPath = property.pathname;
  if (propertyPath === '/') return true;
  const descendantPrefix = propertyPath.endsWith('/')
    ? propertyPath
    : `${propertyPath}/`;

  return (
    target.pathname === propertyPath ||
    target.pathname.startsWith(descendantPrefix)
  );
}

function isWithinDomainProperty(target: URL, domain: string): boolean {
  return target.hostname === domain || target.hostname.endsWith(`.${domain}`);
}

/**
 * Confirms that an Indexing API URL is contained by an owner-level Search
 * Console property available to the authenticated account. URL parsing avoids
 * string-prefix and userinfo lookalike bypasses before any page fetch occurs.
 */
export function assertIndexingUrlAuthorized(
  url: string,
  siteUrl: string,
  sites: SearchConsoleSite[],
): void {
  const target = parseHttpUrl(url, 'url');
  const normalizedSiteUrl = normalizeSiteUrl(siteUrl);
  const authorizedSite = sites.find((site) => {
    if (site.permissionLevel !== SITE_OWNER_PERMISSION) return false;
    try {
      return normalizeSiteUrl(site.siteUrl) === normalizedSiteUrl;
    } catch {
      return false;
    }
  });

  if (!authorizedSite) {
    throw new Error(
      'site_url must be a Search Console property where the authenticated Google account is an owner.',
    );
  }

  if (normalizedSiteUrl.startsWith(DOMAIN_PROPERTY_PREFIX)) {
    if (isWithinDomainProperty(target, parseDomainProperty(normalizedSiteUrl))) {
      return;
    }
  } else if (isWithinUrlPrefix(target, new URL(normalizedSiteUrl))) {
    return;
  }

  throw new Error('url must belong to the authorized site_url Search Console property.');
}

export function assertIndexingRequestUrl(url: string): void {
  parseHttpUrl(url, 'url');
}
