const express = require('express');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const app = express();
const PORT = 3000;

const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

const streamCache = {}; 

function sanitizeFilename(title) {
    if (!title) return 'video_' + Date.now();
    let sanitized = title.replace(/[^\w\s\u0980-\u09FF-]/gi, ''); 
    sanitized = sanitized.trim().replace(/\s+/g, ' ');
    if (!sanitized) return 'video_' + Date.now();
    return sanitized;
}

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,Authorization,Range');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ১. রিয়েল-টাইম সার্চ সাজেশন
app.get('/api/suggest', (req, res) => {
    const q = req.query.q;
    if (!q) return res.json([]);
    const targetUrl = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`;
    
    https.get(targetUrl, (apiRes) => {
        let body = '';
        apiRes.on('data', chunk => body += chunk);
        apiRes.on('end', () => {
            try {
                const data = JSON.parse(body);
                res.json(data[1] || []);
            } catch(e) {
                res.json([]);
            }
        });
    }).on('error', () => {
        res.json([]);
    });
});

// ২. yt-dlp সার্চ এপিআই
app.get('/api/search', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    try {
        const results = await searchYouTube(q);
        res.json({ results });
    } catch (e) {
        console.error("Search error:", e);
        res.status(500).json({ error: "Search failed", results: [] });
    }
});

// ৩. লিঙ্ক মেটাডাটা এক্সট্র্যাক্টর
app.get('/api/info', (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) return res.status(400).json({ error: 'URL is required' });

    const ytDlp = spawn('yt-dlp', [
        '-j', 
        '--extractor-args', 'youtube:player_client=android',
        videoUrl
    ]);
    let stdout = '';
    
    ytDlp.stdout.on('data', (data) => stdout += data.toString());
    
    ytDlp.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
            try {
                const info = JSON.parse(stdout);
                res.json({
                    title: info.title || "অনলাইন ভিডিও লিঙ্ক",
                    thumbnail: info.thumbnail || "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=500",
                    duration: formatDuration(info.duration)
                });
            } catch (e) {
                res.json({ title: "অনলাইন ভিডিও লিঙ্ক", thumbnail: "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=500", duration: "00:00" });
            }
        } else {
            res.json({ title: "অনলাইন ভিডিও লিঙ্ক", thumbnail: "https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=500", duration: "00:00" });
        }
    });
});

function formatDuration(sec) {
    if (!sec) return "00:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

// ৪. প্লেব্যাক ফিক্স: অ্যান্ড্রয়েড ক্লায়েন্ট দিয়ে আইপি-লক মুক্ত ডিরেক্ট ভিডিও প্লেব্যাক লিংক জেনারেট ও রিডিরেক্ট
app.get('/api/stream', async (req, res) => {
    const videoUrl = req.query.url;
    const quality = req.query.quality || '360p';
    if (!videoUrl) return res.status(400).send('URL is required');

    const cacheKey = `${videoUrl}_${quality}`;
    let directUrl = '';

    if (streamCache[cacheKey] && streamCache[cacheKey].expiry > Date.now()) {
        directUrl = streamCache[cacheKey].directUrl;
    } else {
        try {
            // প্লেব্যাক বাফারিং সমস্যা সমাধানের জন্য কেবল কম্বাইন্ড/প্রোগ্রেসিভ ফরম্যাট ব্যবহার করা হয়েছে
            let format = '18/best[height<=360][ext=mp4]/best';
            if (quality === '1080p') format = 'best[height<=1080][ext=mp4]/best';
            if (quality === '720p') format = '22/best[height<=720][ext=mp4]/best';
            if (quality === '480p') format = 'best[height<=480][ext=mp4]/best';
            if (quality === '360p') format = '18/best[height<=360][ext=mp4]/best';

            directUrl = await getDirectUrl(videoUrl, format);
            streamCache[cacheKey] = {
                directUrl: directUrl,
                expiry: Date.now() + (1000 * 60 * 60) 
            };
        } catch (err) {
            return res.status(500).send('Streaming resolution failed: ' + err.message);
        }
    }

    // ব্রাউজারকে ডিরেক্ট গুগল সার্ভারে রিডিরেক্ট করা হলো যেন বাফারিং ছাড়া সর্বোচ্চ গতিতে কাটা-কাটি করা যায়
    res.redirect(302, directUrl);
});

// ৫. ডাউনলোড ফিক্স: yt-dlp পাইপিংয়ের মাধ্যমে সরাসরি অন-দ্য-ফ্লাই ফাস্ট ডাউনলোড যা সরাসরি গ্যালারিতে যাবে
app.get('/api/download-fast', async (req, res) => {
    const videoUrl = req.query.url;
    const quality = req.query.quality || '360p';
    const title = req.query.title || 'video_' + Date.now();

    if (!videoUrl) return res.status(400).send('URL is required');

    let format = 'best[ext=mp4]/best';
    if (quality === '1080p') format = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    if (quality === '720p') format = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    if (quality === '480p') format = 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    if (quality === '360p') format = 'best[height<=360][ext=mp4]/best';
    if (quality === 'audio_high' || quality === 'audio') format = 'ba[ext=m4a]/bestaudio';

    const ext = (quality === 'audio' || quality === 'audio_high') ? 'm4a' : 'mp4';
    const safeTitle = sanitizeFilename(title);

    // ফাইলটি রেন্ডারে জমা না করে সরাসরি ব্রাউজার স্ট্রিমে পাইপ করা হলো
    res.attachment(`${safeTitle}.${ext}`);
    res.setHeader('Content-Type', (quality === 'audio' || quality === 'audio_high') ? 'audio/mp4' : 'video/mp4');

    const ytDlp = spawn('yt-dlp', [
        '-f', format,
        '-o', '-', // stdout-এ সরাসরি ফাইল রাইট করবে
        '--no-playlist',
        '--no-warnings',
        '--ignore-errors',
        '--extractor-args', 'youtube:player_client=android',
        videoUrl
    ]);

    ytDlp.stdout.pipe(res);

    ytDlp.on('close', (code) => {
        if (code !== 0) {
            console.error(`yt-dlp download exited with code ${code}`);
        }
    });

    req.on('close', () => {
        ytDlp.kill();
    });
});

function getDirectUrl(videoUrl, format) {
    return new Promise((resolve, reject) => {
        const ytDlp = spawn('yt-dlp', [
            '-f', format,
            '--no-playlist',
            '--no-warnings',
            '--ignore-errors',
            '--extractor-args', 'youtube:player_client=android',
            '-g',
            videoUrl
        ]);
        let stdout = '';
        let stderr = '';
        ytDlp.stdout.on('data', d => stdout += d.toString());
        ytDlp.stderr.on('data', d => stderr += d.toString());
        ytDlp.on('close', (code) => {
            if (code === 0 && stdout.trim()) {
                resolve(stdout.trim().split('\n')[0]);
            } else {
                reject(new Error(stderr || 'yt-dlp stream resolution returned empty'));
            }
        });
    });
}

function searchYouTube(query) {
    return new Promise((resolve, reject) => {
        const ytDlp = spawn('yt-dlp', [
            `ytsearch45:${query}`,
            '--flat-playlist',
            '--dump-single-json',
            '--no-warnings',
            '--ignore-errors',
            '--extractor-args', 'youtube:player_client=android'
        ]);

        let stdout = '';
        let stderr = '';

        ytDlp.stdout.on('data', (data) => stdout += data.toString());
        ytDlp.stderr.on('data', (data) => stderr += data.toString());

        ytDlp.on('close', (code) => {
            if (code === 0 && stdout.trim()) {
                try {
                    const data = JSON.parse(stdout);
                    const results = [];
                    if (data.entries && data.entries.length > 0) {
                        data.entries.forEach(entry => {
                            if (entry.id && entry.title) {
                                const durationSec = entry.duration || 0;
                                let durationStr = "00:00";
                                if (durationSec > 0) {
                                    const m = Math.floor(durationSec / 60);
                                    const s = Math.floor(durationSec % 60).toString().padStart(2, '0');
                                    durationStr = `${m}:${s}`;
                                }

                                results.push({
                                    id: entry.id,
                                    title: entry.title,
                                    duration: durationStr,
                                    thumbnail: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
                                    url: 'https://www.youtube.com/watch?v=' + entry.id
                                });
                            }
                        });
                    }
                    resolve(results);
                } catch (e) {
                    reject(e);
                }
            } else {
                reject(new Error(stderr || 'yt-dlp search empty'));
            }
        });
    });
}

function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            const alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return null;
}

app.listen(PORT, () => {
    const localIp = getLocalIpAddress();
    console.log("====================================================");
    console.log("🚀 সার্ভার সফলভাবে চালু হয়েছে!");
    console.log("💻 লোকাল: http://localhost:" + PORT);
    if (localIp) {
        console.log("📱 মোবাইল: http://" + localIp + ":" + PORT);
    }
    console.log("====================================================");
});
