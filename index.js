const express = require('express');
const { spawn } = require('child_process');
const https = require('https');
const os = require('os');

const app = express();
const PORT = 3000;

const streamCache = {}; // এক্সট্র্যাক্ট করা স্ট্রিমিং লিঙ্ক ক্যাশ

// ব্যাকগ্রাউন্ড প্রি-ফেচ কিউ
let prefetchQueue = [];
let isPrefetching = false;

// yt-dlp থেকে সরাসরি এবং অত্যন্ত দ্রুত স্ট্রিমিং লিঙ্ক এক্সট্র্যাক্ট করার কোর হেল্পার
function getDirectStreamUrl(videoUrl, quality) {
    return new Promise((resolve, reject) => {
        let format = '18/best[ext=mp4]/best';
        if (quality === '1080p') format = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best';
        if (quality === '720p') format = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best';
        if (quality === '480p') format = 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best';
        if (quality === '360p') format = '18/best[height<=360][ext=mp4]/best';
        if (quality === 'audio' || quality === 'audio_high') format = 'ba[ext=m4a]/bestaudio';

        const ytDlp = spawn('yt-dlp', [
            '-f', format, 
            '--no-playlist', 
            '--no-warnings', 
            '--ignore-errors', 
            '--no-config',                    
            '--no-check-certificate',          
            '--youtube-skip-dash-manifest',    
            '--youtube-skip-hls-manifest',     
            '--extractor-args', 'youtube:player_client=default,-android_sdkless',
            '-g', 
            videoUrl
        ]);

        let stdout = '';
        let stderr = '';

        ytDlp.stdout.on('data', (data) => stdout += data.toString());
        ytDlp.stderr.on('data', (data) => stderr += data.toString());

        ytDlp.on('close', (code) => {
            if (code === 0 && stdout.trim()) {
                const streamDirectUrl = stdout.trim().split('\n')[0];
                resolve(streamDirectUrl);
            } else {
                reject(new Error(stderr || 'Streaming extraction failed'));
            }
        });
    });
}

// সিকুয়েনশিয়াল ব্যাকগ্রাউন্ড প্রি-ফেচিং রানার
async function processPrefetchQueue() {
    if (isPrefetching || prefetchQueue.length === 0) return;
    isPrefetching = true;

    while (prefetchQueue.length > 0) {
        const item = prefetchQueue.shift();
        const cacheKey = `${item.url}_${item.quality}`;

        if (streamCache[cacheKey] && streamCache[cacheKey].expiry > Date.now()) {
            continue; 
        }

        try {
            const directUrl = await getDirectStreamUrl(item.url, item.quality);
            if (directUrl) {
                streamCache[cacheKey] = {
                    directUrl: directUrl,
                    expiry: Date.now() + (1000 * 60 * 60 * 3) // ৩ ঘণ্টার জন্য ক্যাশ
                };
            }
        } catch (e) {
            console.log(`[Prefetch Ignored]: ${item.title.substring(0, 20)} - ${e.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
    }

    isPrefetching = false;
}

function triggerPrefetch(videos) {
    videos.forEach(video => {
        prefetchQueue.push({
            url: video.url,
            title: video.title,
            quality: '360p' 
        });
    });
    processPrefetchQueue();
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

        if (results && results.length > 0) {
            triggerPrefetch(results.slice(0, 4));
        }
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
        '--no-playlist',
        '--no-config',
        '--no-check-certificate',
        '--extractor-args', 'youtube:player_client=default,-android_sdkless',
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

// ৪. ক্যাশ মেমোরি নিয়ন্ত্রিত হাই-স্পীড প্লেব্যাক এবং ডাউনলোডের জন্য রিডাইরেক্ট এপিআই
app.get('/api/stream', async (req, res) => {
    const videoUrl = req.query.url;
    const quality = req.query.quality || '360p';
    if (!videoUrl) return res.status(400).send('URL is required');

    const cacheKey = `${videoUrl}_${quality}`;
    
    // ক্যাশ চেক
    if (streamCache[cacheKey] && streamCache[cacheKey].expiry > Date.now()) {
        return res.redirect(302, streamCache[cacheKey].directUrl);
    }

    try {
        const streamDirectUrl = await getDirectStreamUrl(videoUrl, quality);
        
        streamCache[cacheKey] = {
            directUrl: streamDirectUrl,
            expiry: Date.now() + (1000 * 60 * 60 * 3) // ৩ ঘণ্টা ক্যাশ
        };

        // ব্রাউজার বা অ্যাপকে সরাসরি গুগলের আসল ভিডিও লিংকে রিডাইরেক্ট করে দেওয়া হলো
        res.redirect(302, streamDirectUrl);
    } catch (err) {
        res.status(500).send('Streaming failed: ' + err.message);
    }
});

// yt-dlp সার্চ মেথড
function searchYouTube(query) {
    return new Promise((resolve, reject) => {
        const ytDlp = spawn('yt-dlp', [
            `ytsearch20:${query}`,
            '--flat-playlist',
            '--dump-single-json',
            '--no-warnings',
            '--ignore-errors',
            '--no-config',                     
            '--no-check-certificate',           
            '--extractor-args', 'youtube:player_client=default,-android_sdkless'
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
    console.log("🚀 জিরো-স্টোরেজ ব্যাকএন্ড সফলভাবে চালু হয়েছে!");
    console.log("💻 লোকাল: http://localhost:" + PORT);
    if (localIp) {
        console.log("📱 মোবাইল: http://" + localIp + ":" + PORT);
    }
    console.log("====================================================");
});
