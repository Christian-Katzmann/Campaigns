const NEW_FEATURE_URL = 'https://github.com/Christian-Katzmann/Campaigns/issues/new';

export function buildFeatureRequestUrl({ version, platform }) {
  const query = new URLSearchParams({
    template: 'feature_request.md',
    body: `Version: ${version}\nPlatform: ${platform}`,
  });
  return `${NEW_FEATURE_URL}?${query}`;
}
