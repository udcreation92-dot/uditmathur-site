const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const RECORDINGS_DIR = 'D:\\recordings';

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// List cameras
app.get('/recordings', (req, res) => {
  if (!fs.existsSync(RECORDINGS_DIR)) return res.json([]);
  const cameras = fs.readdirSync(RECORDINGS_DIR)
    .filter(f => fs.statSync(path.join(RECORDINGS_DIR, f)).isDirectory());
  res.json(cameras);
});

// List dates for a camera
app.get('/recordings/:camera', (req, res) => {
  const dir = path.join(RECORDINGS_DIR, req.params.camera);
  if (!fs.existsSync(dir)) return res.json([]);
  const dates = fs.readdirSync(dir)
    .filter(f => fs.statSync(path.join(dir, f)).isDirectory())
    .sort().reverse();
  res.json(dates);
});

// List files for a camera/date
app.get('/recordings/:camera/:date', (req, res) => {
  const dir = path.join(RECORDINGS_DIR, req.params.camera, req.params.date);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.mp4'))
    .sort()
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, size: stat.size, time: f.replace('.mp4', '').replace(/-/g, ':') };
    });
  res.json(files);
});

// Serve video file with range support (seekable)
app.get('/recordings/:camera/:date/:file', (req, res) => {
  const filePath = path.join(RECORDINGS_DIR, req.params.camera, req.params.date, req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(8080, () => console.log('Recordings server running on :8080'));
