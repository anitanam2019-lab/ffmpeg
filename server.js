const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));

const API_TOKEN = process.env.API_TOKEN || '';
const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => res.json({ ok: true, service: 'ffmpeg-render' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

function checkAuth(req, res) {
  if (!API_TOKEN) return true;
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (token !== API_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function download(url, dest) {
  const resp = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'railway-ffmpeg/1.0', Accept: '*/*' },
  });
  if (!resp.ok) throw new Error(`Не удалось скачать ${url}: HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
  if (buf.length === 0) throw new Error(`Пустой файл по ссылке ${url}`);
  return dest;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg завершился с кодом ' + code + ':\n' + stderr.slice(-2000)));
    });
  });
}

app.post('/render', async (req, res) => {
  if (!checkAuth(req, res)) return;

  const body = req.body || {};
  const images = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
  const audio = body.audio;
  const secondsPerImage = Number(body.secondsPerImage) > 0 ? Number(body.secondsPerImage) : 5;
  const width = Number(body.width) > 0 ? Number(body.width) : 900;
  const height = Number(body.height) > 0 ? Number(body.height) : 1600;

  if (images.length === 0) return res.status(400).json({ error: 'Нужен непустой массив images' });
  if (!audio) return res.status(400).json({ error: 'Нужна ссылка audio' });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  const outPath = path.join(workDir, 'out.mp4');

  try {
    const imgPaths = [];
    for (let i = 0; i < images.length; i++) {
      const p = path.join(workDir, `img${i}`);
      await download(images[i], p);
      imgPaths.push(p);
    }
    const audioPath = path.join(workDir, 'audio');
    await download(audio, audioPath);

    const args = [];
    imgPaths.forEach((p) => {
      args.push('-loop', '1', '-t', String(secondsPerImage), '-i', p);
    });
    args.push('-i', audioPath);

    const parts = [];
    const labels = [];
    imgPaths.forEach((_p, i) => {
      parts.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30[v${i}]`
      );
      labels.push(`[v${i}]`);
    });
    const concat = `${labels.join('')}concat=n=${imgPaths.length}:v=1:a=0[v]`;
    const filter = parts.join(';') + ';' + concat;

    const audioIndex = imgPaths.length;
    args.push(
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', `${audioIndex}:a`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      '-y',
      outPath
    );

    await runFfmpeg(args);

    const stat = fs.statSync(outPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('Content-Disposition', 'attachment; filename="video.mp4"');
    const stream = fs.createReadStream(outPath);
    stream.pipe(res);
    stream.on('close', () => { fs.rmSync(workDir, { recursive: true, force: true }); });
  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    console.error(err);
    res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
});

app.listen(PORT, () => { console.log(`ffmpeg-render service listening on ${PORT}`); });
