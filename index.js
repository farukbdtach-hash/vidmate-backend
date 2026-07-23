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

// ৪. প্লেব্যাক ফিক্স: Range Request Proxying (IP-Lock মুক্ত এবং দ্রুত বাফারিং ছাড়া প্লেব্যাক ও কাটা-কাটি)
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
            // প্রগ্রেসিভ সিঙ্গেল ফাইল ফরম্যাট ব্যবহারের মাধ্যমে দ্রুত স্ট্রিমিং নিশ্চিত করা হয়েছে
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

    // ব্রাউজারের Range Request ইউটিউব সার্ভারে প্রক্সি করা হলো, যা কাটা-কাটি (Seeking) দ্রুত করবে
    try {
        const parsedUrl = new URL(directUrl);
        const headers = {};
        
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }
        headers['User-Agent'] = req.headers['user-agent'] || 'Mozilla/5.0';

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: headers
        };

        const proxyReq = https.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (e) => {
            console.error('Proxy request error:', e);
            if (!res.headersSent) res.sendStatus(500);
        });

        req.on('close', () => {
            proxyReq.destroy();
        });

        proxyReq.end();

    } catch (e) {
        res.status(500).send('Streaming error occurred');
    }
});

// ৫. ডাউনলোড ফিক্স: সরাসরি মোবাইলের গ্যালারিতে সেভ হওয়ার জন্য হেডার এবং ১০৮০পি মার্জিং ফিক্স
app.get('/api/download-fast', async (req, res) => {
    const videoUrl = req.query.url;
    const quality = req.query.quality || '360p';
    const title = req.query.title || 'video_' + Date.now();

    if (!videoUrl) return res.status(400).send('URL is required');

    const safeTitle = sanitizeFilename(title);
    const ext = (quality === 'audio' || quality === 'audio_high') ? 'm4a' : 'mp4';

    // ফাইল ডাউনলোড রেসপন্স হেডার (যাতে ব্রাউজার সরাসরি গ্যালারিতে সেভ করার অপশন পায়)
    res.attachment(`${safeTitle}.${ext}`);
    res.setHeader('Content-Type', (quality === 'audio' || quality === 'audio_high') ? 'audio/mp4' : 'video/mp4');

    // ১০৮০পি ভিডিও ডাউনলোড করার জন্য ভিডিও ও অডিও মার্জ করা প্রয়োজন যা সরাসরি পাইপ করা সম্ভব নয়।
    // তাই এটি প্রথমে সার্ভারে ডাউনলোড ও মার্জ হয়ে সরাসরি ইউজারের ফোনে চলে যাবে এবং সার্ভার থেকে ডিলিট হয়ে যাবে।
    if (quality === '1080p') {
        const tempFilePath = path.join(downloadsDir, `${safeTitle}_temp_${Date.now()}.${ext}`);
        
        const ytDlpDownload = spawn('yt-dlp', [
            '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '-o', tempFilePath,
            '--no-playlist',
            '--no-warnings',
            '--ignore-errors',
            '--extractor-args', 'youtube:player_client=android',
            videoUrl
        ]);

        ytDlpDownload.on('close', (code) => {
            if (code === 0 && fs.existsSync(tempFilePath)) {
                res.download(tempFilePath, `${safeTitle}.${ext}`, (err) => {
                    // ডাউনলোড শেষ হলে সার্ভারের জায়গা বাঁচাতে টেম্পোরারি ফাইল ডিলিট করা হলো
                    fs.unlink(tempFilePath, () => {});
                });
            } else {
                if (!res.headersSent) res.status(500).send('Download and merge failed.');
            }
        });

        req.on('close', () => {
            ytDlpDownload.kill();
            if (fs.existsSync(tempFilePath)) fs.unlink(tempFilePath, () => {});
        });
        return;
    }

    // ৩৬০পি বা ৭২০পি-র জন্য সরাসরি ইনস্ট্যান্ট ফাস্ট স্ট্রিম পাইপিং (মার্জ করার প্রয়োজন নেই)
    let format = '18/best[height<=360][ext=mp4]/best';
    if (quality === '720p') format = '22/best[height<=720][ext=mp4]/best';
    if (quality === '480p') format = '18/best[height<=480][ext=mp4]/best';
    if (quality === '360p') format = '18/best[height<=360][ext=mp4]/best';
    if (quality === 'audio_high' || quality === 'audio') format = '140/ba[ext=m4a]/bestaudio';

    const ytDlp = spawn('yt-dlp', [
        '-f', format,
        '-o', '-', 
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
