import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function normalizeCampaignName(value) {
  if (typeof value !== 'string') {
    throw scaffoldError(400, 'Campaign name is required.');
  }

  const title = value.trim();
  if (!title || title.length > 120) {
    throw scaffoldError(400, 'Campaign name must be between 1 and 120 characters.');
  }
  if (/[\\/]/.test(title) || title.includes('..') || /[\u0000-\u001f\u007f]/.test(title)) {
    throw scaffoldError(400, 'Campaign name cannot contain path separators or traversal.');
  }

  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');

  if (!slug) {
    throw scaffoldError(400, 'Campaign name must contain at least one letter or number.');
  }

  return { title, slug };
}

export function campaignTemplate(title) {
  return `# ${title}

> A new campaign. Shape the work here, then move through it one checked step at a time.

## Scope

Describe the outcome this campaign should produce.

## Context (locked decisions)

- Keep the markdown file as the source of truth.
- Add constraints and decisions here before work starts.

## How prompts work in this campaign

Each step has a fenced prompt you can copy into any agent, or follow yourself. The checklist drives progress in Campaigns.

## Progress checklist

### Phase 1 - Plan and ship

- [ ] Step 1.1 - Define the outcome
- [ ] Step 1.2 - Ship the result
- [ ] Final review

## Step 1.1 - Define the outcome

Model: GPT-5.6-Sol - High
Parallel: NO

Make the target concrete before building.

\`\`\`text
SCOPE: Define the smallest useful outcome for this campaign.
OUTPUT: A clear target and the constraints that matter.
OPEN QUESTIONS:
- What must be true when this campaign is done?
\`\`\`

## Step 1.2 - Ship the result

Model: GPT-5.6-Sol - High
Parallel: NO

Build and verify the agreed outcome.

\`\`\`text
SCOPE: Implement the campaign outcome.
OUTPUT: The finished result with practical verification.
OPEN QUESTIONS:
- What is the shortest trustworthy way to prove it works?
\`\`\`

## Final review

Run one campaign-level review before closing the campaign.

\`\`\`text
Review the completed steps and decide whether the stated outcome is done.

APPROVED if the outcome is complete and verified.
NEEDS WORK if a concrete gap remains.
\`\`\`
`;
}

export async function createCampaignScaffold({ name, projectPath }) {
  if (typeof projectPath !== 'string' || !projectPath.trim() || projectPath.includes('\0')) {
    throw scaffoldError(400, 'Project folder is required.');
  }

  const { title, slug } = normalizeCampaignName(name);
  const campaignsDir = path.join(path.resolve(projectPath.trim()), 'campaigns');
  const filePath = path.join(campaignsDir, `${slug}.md`);

  await mkdir(campaignsDir, { recursive: true });
  try {
    await writeFile(filePath, campaignTemplate(title), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw scaffoldError(409, `A campaign named "${title}" already exists.`);
    }
    throw error;
  }

  return { filePath, slug, title };
}

function scaffoldError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
