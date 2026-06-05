#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const owner = process.env.GITHUB_OWNER ?? 'zesming';
const repo = process.env.GITHUB_REPO ?? 'donkey';
const token = process.env.GITHUB_TOKEN;
const sha =
  process.env.GITHUB_SHA_TO_CHECK ??
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const url = new URL(
  `https://api.github.com/repos/${owner}/${repo}/actions/runs`,
);
url.searchParams.set('branch', 'rebuild-v2');
url.searchParams.set('head_sha', sha);
url.searchParams.set('per_page', '10');

if (!token) {
  console.error('GITHUB_TOKEN is required to verify remote GitHub Actions.');
  console.error(`Target: ${owner}/${repo}@${sha}`);
  process.exit(2);
}

const response = await fetch(url, {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
});

if (!response.ok) {
  console.error(
    `GitHub API request failed: ${response.status} ${response.statusText}`,
  );
  console.error(await response.text());
  process.exit(1);
}

const payload = await response.json();
const runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
const coreRuns = runs.filter((run) => run.name === 'Core');

if (coreRuns.length === 0) {
  console.error(`No Core workflow run found for ${sha}.`);
  process.exit(1);
}

const latest = coreRuns[0];
console.log(
  `${latest.name} #${latest.run_number}: ${latest.status}/${
    latest.conclusion ?? 'pending'
  }`,
);
console.log(latest.html_url);

if (latest.status !== 'completed' || latest.conclusion !== 'success') {
  process.exit(1);
}
