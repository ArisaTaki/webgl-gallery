import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { loadRuntimeConfig, publicSetupStatus, saveRuntimeConfig } from '../server/runtimeConfig.js';
import { projectRootFromImportMeta, resolveRuntimePaths } from '../server/runtimePaths.js';

const args = new Set(process.argv.slice(2));
const root = projectRootFromImportMeta(import.meta.url);
const paths = resolveRuntimePaths(root);
const runtime = await loadRuntimeConfig(paths);
const status = publicSetupStatus(runtime);
const scriptedAnswers = input.isTTY ? null : await readScriptedAnswers();
const rl = input.isTTY ? createInterface({ input, output }) : null;

try {
  console.log('\n念念照片画廊设置');
  console.log(`配置文件: ${projectPath(runtime.configPath)}`);
  console.log('推荐普通使用：Local SQLite + Local folder。线上或多设备访问：Postgres + Cloudflare R2。\n');

  const payload: any = {};
  payload.databaseKind = await choose('元数据保存在哪里', databaseChoices(status), status.database.kind || 'sqlite');
  if (payload.databaseKind === 'sqlite') {
    payload.sqlitePath = await askPath('SQLite 文件', status.database.sqlitePath || path.join(root, '.gallery', 'gallery.sqlite'));
  } else if (payload.databaseKind === 'json') {
    payload.manifestPath = await askPath('JSON 清单文件', status.database.manifestPath || paths.manifestPath);
  } else {
    payload.databaseUrl = await askSecretValue(
      'Postgres DATABASE_URL',
      runtime.config.database?.databaseUrl || process.env.DATABASE_URL || '',
      true,
    );
  }

  payload.storageKind = await choose('图片文件保存在哪里', storageChoices(), status.storage.kind || 'local');
  if (payload.storageKind === 'local') {
    payload.mediaDir = await askPath('公开图片目录 thumb/medium/large', status.storage.mediaDir || paths.mediaDir);
    payload.originalDir = await askPath('私有原图备份目录 original', status.storage.originalDir || paths.originalDir);
  } else {
    payload.r2AccountId = await askValue('Cloudflare Account ID', status.storage.accountId || runtime.config.storage?.r2?.accountId || process.env.R2_ACCOUNT_ID || '', true);
    payload.r2AccessKeyId = await askSecretValue('R2 Access Key ID', runtime.config.storage?.r2?.accessKeyId || process.env.R2_ACCESS_KEY_ID || '', true);
    payload.r2SecretAccessKey = await askSecretValue('R2 Secret Access Key', runtime.config.storage?.r2?.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY || '', true);
    payload.r2PublicBucket = await askValue('公开 bucket（缩略图/展示图）', status.storage.publicBucket || runtime.config.storage?.r2?.publicBucket || process.env.R2_PUBLIC_BUCKET || '', true);
    payload.r2PrivateBucket = await askValue('私有 bucket（原图）', status.storage.privateBucket || runtime.config.storage?.r2?.privateBucket || process.env.R2_PRIVATE_BUCKET || '', true);
    payload.r2PublicBaseUrl = await askValue('公开图片域名', status.storage.publicBaseUrl || runtime.config.storage?.r2?.publicBaseUrl || process.env.R2_PUBLIC_BASE_URL || '', true);
  }

  if (!status.auth.hasAdminPassword) {
    payload.adminPassword = await askSecretValue('设置后台密码', '', true);
  } else {
    payload.adminPassword = await askSecretValue('后台密码（留空保留当前密码）', '', false);
  }

  if (args.has('--skip-storage-check')) {
    payload.skipStorageCheck = true;
    console.log('\n已跳过存储连通性检查。');
  } else if (payload.storageKind === 'r2') {
    console.log('\n正在检查 R2：会临时写入并删除两个 _setup-check 对象...');
  }

  const saved = await saveRuntimeConfig(paths, runtime, payload);
  const nextStatus = publicSetupStatus(saved);
  console.log('\n设置完成。');
  console.log(`配置文件: ${projectPath(saved.configPath)}`);
  console.log(`元数据: ${nextStatus.database.kind}`);
  console.log(`图片存储: ${storageSummary(nextStatus.storage)}`);
  console.log('\n下一步：');
  console.log('  npm start');
  console.log('  打开 http://localhost:5279/studio 上传和管理相册\n');
} catch (error: any) {
  console.error(`\n设置失败: ${error.message || error}`);
  process.exitCode = 1;
} finally {
  rl?.close();
}

function databaseChoices(currentStatus) {
  const choices = [
    { value: 'sqlite', label: 'Local SQLite（推荐，单机最省心）' },
    { value: 'json', label: 'Local JSON fallback（兼容模式）' },
    { value: 'postgres', label: 'Postgres（线上/多人访问）' },
  ];
  if (currentStatus.database.sqliteAvailable === false) {
    return choices.map((choice) => choice.value === 'sqlite'
      ? { ...choice, label: `${choice.label} - 当前 Node 不可用` }
      : choice);
  }
  return choices;
}

function storageChoices() {
  return [
    { value: 'local', label: 'Local folder（推荐，图片存在本机文件夹）' },
    { value: 'r2', label: 'Cloudflare R2（公开展示图 + 私有原图）' },
  ];
}

async function choose(label, choices, defaultValue) {
  const fallback = choices.some((choice) => choice.value === defaultValue) ? defaultValue : choices[0].value;
  console.log(label);
  choices.forEach((choice, index) => {
    const marker = choice.value === fallback ? ' *' : '';
    console.log(`  ${index + 1}. ${choice.label}${marker}`);
  });
  while (true) {
    const answer = (await prompt(`选择 [${fallback}]: `)).trim();
    if (!answer) return fallback;
    const byNumber = choices[Number(answer) - 1];
    if (byNumber) return byNumber.value;
    const byValue = choices.find((choice) => choice.value === answer);
    if (byValue) return byValue.value;
    console.log('请输入序号或选项名称。');
  }
}

async function askPath(label, defaultPath) {
  const answer = await askValue(label, projectPath(defaultPath), true);
  return path.isAbsolute(answer) ? answer : path.resolve(root, answer);
}

async function askValue(label, defaultValue = '', required = false) {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await prompt(`${label}${suffix}: `)).trim();
    const value = answer || defaultValue;
    if (value || !required) return value;
    console.log('这个字段不能为空。');
  }
}

async function askSecretValue(label, currentValue = '', required = false) {
  const suffix = currentValue ? ' [已配置，留空保留]' : '';
  while (true) {
    const answer = (await prompt(`${label}${suffix}: `, { secret: true })).trim();
    const value = answer || currentValue;
    if (value || !required) return value;
    console.log('这个字段不能为空。');
  }
}

function projectPath(value) {
  const resolved = path.resolve(String(value || ''));
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : resolved;
}

function storageSummary(storage) {
  if (storage.kind === 'r2') {
    return `Cloudflare R2 (${storage.publicBucket} public, ${storage.privateBucket} private, ${storage.publicBaseUrl})`;
  }
  return `Local folder (${projectPath(storage.mediaDir)} + ${projectPath(storage.originalDir)})`;
}

async function prompt(message, options: any = {}) {
  if (scriptedAnswers) {
    const answer = scriptedAnswers.shift() || '';
    output.write(`${message}${options.secret && answer ? '[hidden]' : answer}\n`);
    return answer;
  }
  return rl!.question(message);
}

async function readScriptedAnswers() {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}
