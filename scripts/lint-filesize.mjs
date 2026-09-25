#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = process.cwd();
const SCAN_DIRS = ['src', 'workers', 'sam'];

// Grandfathered file size limits (ratchet mechanism).
// Files here are strictly capped at their legacy size and must NOT grow larger.
// When refactored down below standard thresholds, files are removed from this list.
const LEGACY_EXEMPTIONS = new Map([]);

const RULES = {
  // Default source modules
  default: {
    pattern: /\.(ts|tsx|js)$/,
    maxLines: 750,
    warnLines: 400,
    label: 'Module',
  },
};

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage']);

function getAllFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        getAllFiles(fullPath, fileList);
      }
    } else if (/\.(ts|tsx|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function countLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content === '' ? 0 : content.split('\n').length - Number(content.endsWith('\n'));
}

function checkFiles() {
  const files = [];
  for (const subDir of SCAN_DIRS) {
    const dirPath = path.join(ROOT_DIR, subDir);
    getAllFiles(dirPath, files);
  }

  let hasErrors = false;
  let warnCount = 0;
  let errorCount = 0;
  let exemptCount = 0;

  console.log('\n📊 Checking Patchwork Core Backend codebase file sizes (TASK-DEBT-ESLINT-FILESIZE-GUARD)...');
  console.log('='.repeat(80));

  const results = [];

  for (const file of files) {
    const relativePath = path.relative(ROOT_DIR, file).replace(/\\/g, '/');
    const lines = countLines(file);
    const isExempt = LEGACY_EXEMPTIONS.has(relativePath);
    const ratchetCeiling = LEGACY_EXEMPTIONS.get(relativePath);

    let rule = RULES.default;

    if (isExempt) {
      if (lines > ratchetCeiling) {
        hasErrors = true;
        errorCount++;
        results.push({
          status: '❌ RATCHET ERROR',
          file: relativePath,
          lines,
          limit: ratchetCeiling,
          type: `${rule.label} (exceeded grandfathered ceiling of ${ratchetCeiling})`,
        });
      } else {
        exemptCount++;
        results.push({
          status: 'ℹ️  EXEMPT',
          file: relativePath,
          lines,
          limit: ratchetCeiling,
          type: `${rule.label} (ratchet cap: ${ratchetCeiling})`,
        });
      }
    } else if (lines > rule.maxLines) {
      hasErrors = true;
      errorCount++;
      results.push({
        status: '❌ ERROR',
        file: relativePath,
        lines,
        limit: rule.maxLines,
        type: rule.label,
      });
    } else if (lines > rule.warnLines) {
      warnCount++;
      results.push({
        status: '⚠️  WARN',
        file: relativePath,
        lines,
        limit: rule.warnLines,
        type: rule.label,
      });
    }
  }

  // Display top 10 largest files
  const allRanked = files
    .map((f) => ({
      file: path.relative(ROOT_DIR, f).replace(/\\/g, '/'),
      lines: countLines(f),
      exempt: LEGACY_EXEMPTIONS.has(path.relative(ROOT_DIR, f).replace(/\\/g, '/')),
    }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 10);

  console.log('\nTop 10 Largest Source Files:');
  allRanked.forEach((item, i) => {
    const tag = item.exempt ? ' (legacy exemption)' : '';
    console.log(`  ${(i + 1).toString().padStart(2)}. ${item.lines.toString().padStart(5)} lines  ${item.file}${tag}`);
  });

  if (results.length > 0) {
    console.log('\nThreshold Notifications:');
    for (const res of results) {
      console.log(`  ${res.status} [${res.type}] ${res.file}: ${res.lines} lines (threshold: ${res.limit})`);
    }
  }

  console.log('='.repeat(80));
  console.log(`Scanned ${files.length} files. Errors: ${errorCount}, Warnings: ${warnCount}, Exemptions: ${exemptCount}`);

  if (hasErrors) {
    console.error('\n❌ File size check failed: files exceeded maximum modular architecture limits or ratchet ceilings.\n');
    process.exit(1);
  } else {
    console.log('\n✅ File size check passed: all files meet modular architecture standards.\n');
    process.exit(0);
  }
}

checkFiles();
