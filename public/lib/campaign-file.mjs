export const CAMPAIGN_FILE_EXTENSION = '.campaign.md';

export function campaignFileName(filePath) {
  return String(filePath ?? '').split(/[\\/]/).at(-1) || '';
}

export function campaignFileStem(filePath) {
  const fileName = campaignFileName(filePath);
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(CAMPAIGN_FILE_EXTENSION)) {
    return fileName.slice(0, -CAMPAIGN_FILE_EXTENSION.length);
  }
  return lowerName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
}
