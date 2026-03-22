#!/usr/bin/env node
/**
 * R2 음원 볼륨 정규화 배치 스크립트
 *
 * FFmpeg loudnorm 2-pass로 라우드니스를 측정하고,
 * -18 LUFS 이하인 파일만 -16 LUFS로 부스트하여 R2에 재업로드한다.
 *
 * Usage:
 *   node normalize-r2-audio.js                              # 전체 버킷
 *   node normalize-r2-audio.js --prefix radio/channel-list1/ # 특정 prefix
 *   node normalize-r2-audio.js --dry-run                     # 측정만
 *   node normalize-r2-audio.js --dry-run --prefix channel3/  # 측정만 + prefix
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');

// ── 설정 ──
const CONFIG = {
  R2_BUCKET: 'coachdb-files',
  THRESHOLD_LUFS: -18,    // 이 값 이하만 처리
  TARGET_LUFS: -16,        // 목표 라우드니스
  TRUE_PEAK: -1.5,         // True Peak 상한
  LRA: 11,                 // Loudness Range
  TEMP_DIR: path.join(os.tmpdir(), 'normalize-work'),
  WORKER_URL: 'https://radio-worker.yebomradio.workers.dev',
  TARGET_PREFIX: '',
  DRY_RUN: false,
};

const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|ogg|wav|flac|opus)$/i;

// ── CLI 인자 파싱 ──
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--dry-run') CONFIG.DRY_RUN = true;
  if (process.argv[i] === '--prefix' && process.argv[i + 1]) CONFIG.TARGET_PREFIX = process.argv[++i];
}

// ── 유틸 ──
function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, ...opts });
}

function ensureTempDir() {
  if (!fs.existsSync(CONFIG.TEMP_DIR)) fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true });
}

function cleanup(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

// ── 사전 체크 ──
function preflight() {
  try { run('ffmpeg -version'); } catch {
    console.error('❌ FFmpeg가 설치되어 있지 않습니다.');
    process.exit(1);
  }
  try { run('wrangler --version'); } catch {
    console.error('❌ wrangler CLI가 설치되어 있지 않습니다.');
    process.exit(1);
  }
}

// ── HTTP fetch (Node.js 내장) ──
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── R2 파일 목록 조회 (Worker API 경유) ──
async function listR2Objects(prefix) {
  // Worker /api/tracks?channel=XXX 를 통해 목록 조회
  // DIR_MAP: { list1: 'radio/channel-list1/', list2: 'radio/channel-list2/', stream: 'radio/channel-stream/' }
  const prefixToChannel = {
    'radio/channel-list1/': 'list1',   // CH3 말씀의 전당
    'radio/channel-list2/': 'list2',   // CH4 찬양의 숲
    'radio/channel-stream/': 'stream', // CH5 봄소리
  };
  const channelId = prefixToChannel[prefix];
  if (channelId) {
    const tracks = await fetchJSON(`${CONFIG.WORKER_URL}/api/tracks?channel=${channelId}`);
    return Array.isArray(tracks) ? tracks.map(t => ({ key: t.key, size: t.size || 0 })) : [];
  }
  // prefix가 없으면 모든 채널 + openroom 순회
  const allTracks = [];
  for (const [pfx, ch] of Object.entries(prefixToChannel)) {
    if (!prefix || pfx.startsWith(prefix)) {
      const tracks = await fetchJSON(`${CONFIG.WORKER_URL}/api/tracks?channel=${ch}`);
      if (Array.isArray(tracks)) allTracks.push(...tracks.map(t => ({ key: t.key, size: t.size || 0 })));
    }
  }
  // openroom 폴더도 추가
  try {
    const orFolders = await fetchJSON(`${CONFIG.WORKER_URL}/api/openroom/folders`);
    if (Array.isArray(orFolders)) {
      for (const folder of orFolders) {
        const orTracks = await fetchJSON(`${CONFIG.WORKER_URL}/api/openroom/tracks?folder=${encodeURIComponent(folder.name)}`);
        if (Array.isArray(orTracks)) allTracks.push(...orTracks.map(t => ({ key: t.key, size: t.size || 0 })));
      }
    }
  } catch {}
  return allTracks.filter(obj => AUDIO_EXTENSIONS.test(obj.key));
}

// ── R2 다운로드/업로드 ──
function downloadFromR2(key, localPath) {
  // Worker API의 스트리밍 엔드포인트를 사용 (한글/특수문자 안전)
  const streamUrl = `${CONFIG.WORKER_URL}/api/stream/${key.split('/').map(encodeURIComponent).join('/')}`;
  return new Promise((resolve, reject) => {
    const mod = streamUrl.startsWith('https') ? https : http;
    const file = fs.createWriteStream(localPath);
    mod.get(streamUrl, res => {
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        file.close();
        reject(new Error(`Download HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', e => { file.close(); reject(e); });
  });
}

function uploadToR2(key, localPath) {
  const ext = path.extname(key).toLowerCase();
  const contentTypes = {
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.opus': 'audio/ogg',
  };
  const ct = contentTypes[ext] || 'audio/mpeg';
  // 최대 3회 재시도
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      run(`wrangler r2 object put "${CONFIG.R2_BUCKET}/${key}" --file "${localPath}" --content-type "${ct}"`);
      return;
    } catch (e) {
      if (attempt === 3) throw e;
      console.log(`  ⟳ 업로드 재시도 ${attempt}/3...`);
    }
  }
}

// ── FFmpeg 라우드니스 측정 (1st pass) ──
function measureLoudness(filePath) {
  // spawnSync로 stderr를 확실하게 캡처 (ffmpeg은 결과를 stderr로 출력)
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-i', filePath,
    '-af', `loudnorm=I=${CONFIG.TARGET_LUFS}:TP=${CONFIG.TRUE_PEAK}:LRA=${CONFIG.LRA}:print_format=json`,
    '-f', 'null', '-'
  ], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  const stderr = result.stderr || '';
  // JSON 블록 추출
  const jsonMatch = stderr.match(/\{[^{}]*"input_i"\s*:\s*"[^"]*"[^{}]*\}/s);
  if (!jsonMatch) throw new Error('FFmpeg JSON 파싱 실패');
  const data = JSON.parse(jsonMatch[0]);
  return {
    input_i: parseFloat(data.input_i),
    input_tp: parseFloat(data.input_tp),
    input_lra: parseFloat(data.input_lra),
    input_thresh: parseFloat(data.input_thresh),
    target_offset: parseFloat(data.target_offset),
  };
}

// ── FFmpeg 라우드니스 정규화 (2nd pass) ──
function normalizeLoudness(filePath, m) {
  const ext = path.extname(filePath);
  const outputPath = filePath.replace(ext, `_normalized${ext}`);

  // 원본 비트레이트 확인
  let bitrate = 192;
  try {
    const probeOut = run(`ffprobe -v error -select_streams a:0 -show_entries stream=bit_rate -of csv=p=0 "${filePath}"`);
    const parsed = parseInt(probeOut.trim()) / 1000;
    if (parsed > 0) bitrate = Math.min(parsed, 192);
  } catch {}

  const af = `loudnorm=I=${CONFIG.TARGET_LUFS}:TP=${CONFIG.TRUE_PEAK}:LRA=${CONFIG.LRA}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;

  const extLower = ext.toLowerCase();
  let codecArgs;
  if (extLower === '.mp3') {
    codecArgs = `-codec:a libmp3lame -b:a ${Math.round(bitrate)}k`;
  } else if (extLower === '.m4a' || extLower === '.aac') {
    codecArgs = `-codec:a aac -b:a ${Math.round(bitrate)}k`;
  } else if (extLower === '.ogg') {
    codecArgs = `-codec:a libvorbis -b:a ${Math.round(bitrate)}k`;
  } else if (extLower === '.opus') {
    codecArgs = `-codec:a libopus -b:a ${Math.round(bitrate)}k`;
  } else if (extLower === '.flac') {
    codecArgs = `-codec:a flac`;
  } else if (extLower === '.wav') {
    codecArgs = `-codec:a pcm_s16le`;
  } else {
    codecArgs = `-codec:a libmp3lame -b:a ${Math.round(bitrate)}k`;
  }

  const cmd = `ffmpeg -y -i "${filePath}" -af "${af}" -ar 44100 ${codecArgs} "${outputPath}"`;
  run(cmd);
  return outputPath;
}

// ── 메인 ──
async function main() {
  preflight();
  ensureTempDir();

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  R2 Audio Loudness Normalization');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Bucket:    ${CONFIG.R2_BUCKET}`);
  console.log(`  Prefix:    ${CONFIG.TARGET_PREFIX || '(전체)'}`);
  console.log(`  Threshold: ${CONFIG.THRESHOLD_LUFS} LUFS`);
  console.log(`  Target:    ${CONFIG.TARGET_LUFS} LUFS`);
  console.log(`  Mode:      ${CONFIG.DRY_RUN ? 'DRY-RUN (측정만)' : 'LIVE (측정+정규화+업로드)'}`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  console.log('📋 R2 파일 목록 조회 중...');
  const audioFiles = await listR2Objects(CONFIG.TARGET_PREFIX);
  console.log(`  ${audioFiles.length}개 음원 파일 발견\n`);

  const results = { skipped: [], boosted: [], errors: [] };

  for (let i = 0; i < audioFiles.length; i++) {
    const obj = audioFiles[i];
    const key = obj.key;
    const progress = `[${i + 1}/${audioFiles.length}]`;
    // Windows 금지 문자 치환 (<>:"/\|?*)
    const safeName = path.basename(key).replace(/[<>:"\/\\|?*]/g, '_');
    const localPath = path.join(CONFIG.TEMP_DIR, safeName);

    process.stdout.write(`${progress} ${key} ... `);

    try {
      // 다운로드
      await downloadFromR2(key, localPath);

      // 측정
      const m = measureLoudness(localPath);
      const lufs = m.input_i.toFixed(1);

      if (m.input_i > CONFIG.THRESHOLD_LUFS) {
        console.log(`SKIP (${lufs} LUFS)`);
        results.skipped.push({ key, lufs: m.input_i });
      } else {
        if (CONFIG.DRY_RUN) {
          console.log(`NEEDS BOOST (${lufs} LUFS → ${CONFIG.TARGET_LUFS} LUFS) [dry-run]`);
          results.boosted.push({ key, from: m.input_i, to: CONFIG.TARGET_LUFS });
        } else {
          // 정규화
          const outputPath = normalizeLoudness(localPath, m);
          // 업로드 (원본 키에 덮어쓰기)
          uploadToR2(key, outputPath);
          console.log(`BOOSTED (${lufs} → ${CONFIG.TARGET_LUFS} LUFS) ✓`);
          results.boosted.push({ key, from: m.input_i, to: CONFIG.TARGET_LUFS });
          cleanup(outputPath);
        }
      }
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      results.errors.push({ key, error: e.message });
    }

    // 임시 파일 정리
    cleanup(localPath);
  }

  // 리포트
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Normalization Report');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Total files scanned:  ${audioFiles.length}`);
  console.log(`  Skipped (above ${CONFIG.THRESHOLD_LUFS}):  ${results.skipped.length}`);
  console.log(`  Boosted:              ${results.boosted.length}`);
  console.log(`  Errors:               ${results.errors.length}`);
  console.log('═══════════════════════════════════════════════════');

  if (results.boosted.length > 0) {
    console.log('');
    console.log('  Boosted files:');
    console.log('  ──────────────────────────────────────────────');
    for (const b of results.boosted) {
      console.log(`  ${b.key}    ${b.from.toFixed(1)} → ${b.to} LUFS`);
    }
  }

  if (results.errors.length > 0) {
    console.log('');
    console.log('  Errors:');
    console.log('  ──────────────────────────────────────────────');
    for (const e of results.errors) {
      console.log(`  ${e.key}  ${e.error}`);
    }
  }
  console.log('');

  // 임시 디렉토리 정리
  try { fs.rmSync(CONFIG.TEMP_DIR, { recursive: true }); } catch {}
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
