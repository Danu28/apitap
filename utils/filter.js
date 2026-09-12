/**
 * ApiTap — NoiseFilter
 * Decides whether a captured network call is "API traffic worth keeping"
 * or noise (static assets, analytics/telemetry).
 * Dual-exported for the service worker (globalThis) and Node tests (module.exports).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.NoiseFilter = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ASSET_EXTENSIONS = [
    // images
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.avif', '.jfif',
    // fonts
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
    // styles / scripts / media
    '.css', '.js', '.mjs', '.map', '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.flv', '.m4a',
    '.manifest', '.appcache', '.webmanifest'
  ];

  const ASSET_CONTENT_TYPES = [
    'image/', 'font/', 'audio/', 'video/',
    'text/css', 'application/javascript', 'text/javascript',
    'application/font', 'application/x-font'
  ];

  // Domains that carry telemetry / analytics / product-metrics — never test data.
  // Matched exact or as a subdomain (.d) only; no substring matching (that
  // false-flagged hosts like api.1stdibsdata.com via leftover junk entries).
  const TELEMETRY_DOMAINS = [
    'googletagmanager.com', 'google-analytics.com', 'analytics.google.com',
    'doubleclick.net', 'hotjar.com', 'mixpanel.com', 'segment.io', 'segment.com',
    'amplitude.com', 'sentry.io', 'newrelic.com', 'bugsnag.com', 'fullstory.com',
    'clicktale.net', 'mouseflow.com', 'posthog.com', 'logrocket.com', 'matomo.cloud',
    'crashlytics.com', 'clarity.ms', 'inspectlet.com', 'smartlook.com',
    'datadoghq.com', 'nr-data.net', 'browser-intake-datadoghq.com',
    'quantcast.com', 'chartbeat.com', 'beacon.krxd.net', 'sc-static.net',
    'googlesyndication.com'
  ];

  function hostFromUrl(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return '';
    }
  }

  function isTelemetry(url) {
    const host = hostFromUrl(url).toLowerCase();
    return TELEMETRY_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  }

  function hasAssetExtension(url) {
    let pathname = '';
    try {
      pathname = new URL(url).pathname.toLowerCase();
    } catch (e) {}
    return ASSET_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  }

  function hasAssetContentType(apiCall) {
    const ctype = (apiCall.responseHeaders || [])
      .filter((h) => h && h.name && String(h.name).toLowerCase() === 'content-type' && h.value != null)
      .map((h) => String(h.value).split(';')[0].trim().toLowerCase()).join(',');
    return !!ctype && ASSET_CONTENT_TYPES.some((t) => ctype.includes(t));
  }

  const PREFLIGHT_METHOD = 'OPTIONS';
  const SKIP_RESOURCE_TYPES = new Set(['Stylesheet', 'Image', 'Font', 'Media', 'Manifest']);

  function isPreflight(apiCall) {
    return apiCall && apiCall.method && String(apiCall.method).toUpperCase() === PREFLIGHT_METHOD;
  }
  function hasFilteredResourceType(apiCall) {
    var t = apiCall && apiCall.resourceType;
    return !!(t && SKIP_RESOURCE_TYPES.has(t));
  }
  /**
   * Why a call is noise: 'telemetry' | 'asset-extension' | 'asset-content-type'
   * | 'preflight' | 'resource-type' | 'no-url', or null when it is API traffic worth keeping.
   * @param {object} apiCall
   * @param {object} [opts] { dropPreflight:boolean, strictResourceTypes:boolean }
   */
  function filterReason(apiCall, opts) {
    if (!apiCall || !apiCall.url) return 'no-url';
    if (opts && opts.dropPreflight && isPreflight(apiCall)) return 'preflight';
    if (opts && opts.strictResourceTypes && hasFilteredResourceType(apiCall)) return 'resource-type';
    if (isTelemetry(apiCall.url)) return 'telemetry';
    if (hasAssetExtension(apiCall.url)) return 'asset-extension';
    if (hasAssetContentType(apiCall)) return 'asset-content-type';
    // even when not strict, still drop obvious asset resource types to reduce noise
    if (hasFilteredResourceType(apiCall) && (hasAssetExtension(apiCall.url) || hasAssetContentType(apiCall))) return 'resource-type';
    return null;
  }

  /** Should this call be dropped from the export entirely? */
  function isNoise(apiCall) {
    return filterReason(apiCall) !== null;
  }

  return {
    isNoise: isNoise,
    isTelemetry: isTelemetry,
    filterReason: filterReason
  };
});