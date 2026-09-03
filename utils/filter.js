/**
 * ApiTap — NoiseFilter
 * Decides whether a captured network call is "API traffic worth exporting"
 * or noise (static assets, analytics/telemetry, tracking params).
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
    '.css', '.mjs', '.map', '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.flv', '.m4a',
    '.manifest', '.appcache', '.webmanifest'
  ];

  const ASSET_CONTENT_TYPES = [
    'image/', 'font/', 'audio/', 'video/',
    'text/css', 'application/javascript', 'text/javascript',
    'application/font', 'application/x-font'
  ];

  // Domains that carry telemetry / analytics / product-metrics — never test data.
  const TELEMETRY_DOMAINS = [
    'googletagmanager.com', 'google-analytics.com', 'analytics.google.com',
    'doubleclick.net', 'hotjar.com', 'mixpanel.com', 'segment.io', 'segment.com',
    'amplitude.com', 'sentry.io', 'newrelic.com', 'bugsnag.com', 'fullstory.com',
    'clicktale.net', 'mouseflow.com', 'posthog.com', 'logrocket.com', 'matomo.cloud',
    'crashtrace', 'crashlytics', 'clarity.ms', 'inspectlet.com', 'smartlook.com',
    'datadoghq.com', 'nr-data.net', 'browser-intake-datadoghq.com', '1stdibs',
    'qquared', 'quantcast.com', 'chartbeat.com', 'linkedin.com/analytics',
    'beacon.krxd.net', 'sc-static.net', 'facebook.net/tr', 'gtag', 'googlesyndication'
  ];

  const TRACKING_PARAMS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'gclid', 'dclid', 'fbclid', 'gbraid', 'wbraid', 'igshid',
    'mc_cid', 'mc_eid', 'ref', 'source', 'spm', 'zanpid', 'hsCtaTracking', 'ncid'
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
    return TELEMETRY_DOMAINS.some((d) => host === d || host.endsWith('.' + d) || host.includes(d));
  }

  function isStaticAsset(apiCall) {
    const url = (apiCall && apiCall.url) || '';
    let pathname = '';
    try {
      pathname = new URL(url).pathname.toLowerCase();
    } catch (e) {}

    if (ASSET_EXTENSIONS.some((ext) => pathname.endsWith(ext))) return true;

    const ctype = (apiCall.responseHeaders || [])
      .filter((h) => h && h.name && h.name.toLowerCase() === 'content-type')
      .map((h) => h.value.split(';')[0].trim().toLowerCase()).join(',');

    if (ctype && ASSET_CONTENT_TYPES.some((t) => ctype.includes(t))) return true;

    return false;
  }

  /**
   * Returns a cleaned copy of the URL with tracking params removed.
   */
  function stripTrackingParams(url) {
    if (!url || !url.includes('?')) return url;
    try {
      const u = new URL(url);
      const clean = new URL(url);
      for (const key of TRACKING_PARAMS) clean.searchParams.delete(key);
      return clean.toString();
    } catch (e) {
      // Naive string fallback for malformed URLs.
      let base = url.split('?')[0];
      const query = url.split('?')[1];
      if (!query) return url;
      const kept = query.split('&').filter((pair) => {
        const k = pair.split('=')[0];
        return k && !TRACKING_PARAMS.includes(k);
      });
      return kept.length ? base + '?' + kept.join('&') : base;
    }
  }

  /**
   * Should this call be dropped from the export entirely?
   */
  function isNoise(apiCall) {
    if (!apiCall || !apiCall.url) return true;
    if (isTelemetry(apiCall.url)) return true;
    if (isStaticAsset(apiCall)) return true;
    return false;
  }

  return {
    isNoise: isNoise,
    isStaticAsset: isStaticAsset,
    isTelemetry: isTelemetry,
    stripTrackingParams: stripTrackingParams,
    TELEMETRY_DOMAINS: TELEMETRY_DOMAINS,
    ASSET_EXTENSIONS: ASSET_EXTENSIONS
  };
});