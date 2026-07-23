const express = require('express');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const app = express();
// Render-এর ডায়নামিক পোর্টের জন্য কনফিগারেশন
const PORT = process.env.PORT || 3000;

// অ্যান্ড্রয়েড পাবলিক ডাউনলোড ফোল্ডার অ্যাক্সেস করার পাথ নির্ধারণ
const homeDir = os.homedir();
const termuxSharedDir = path.join(homeDir, 'storage', 'shared', 'Download');
const sdcardDir = '/sdcard/Download';

let downloadsDir = path.join(__dirname, 'downloads'); // Fallback local directory

if (fs.existsSync(sdcardDir)) {
    downloadsDir = path.join(sdcardDir, 'Minitube');
} else if (fs.existsSync(termuxSharedDir)) {
    downloadsDir = path.join(termuxSharedDir, 'Minitube');
}

// ফোল্ডারটি না থাকলে তৈরি করে নেওয়া হবে
if (!fs.existsSync(downloadsDir)) {
    try {
        fs.mkdirSync(downloadsDir, { recursive: true });
    } catch (e) {
        downloadsDir = path.join(__dirname, 'downloads');
        if (!fs.existsSync(downloadsDir)) {
            fs.mkdirSync(downloadsDir);
        }
    }
}

const downloadsInProgress = {};
const streamCache = {}; 

const keepAliveAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 300,
    keepAliveMsecs: 15000
});

// গ্লোবাল বা লোকাল yt-dlp ট্র্যাক করার ভ্যারিয়েবল
let YTDLP_PATH = 'yt-dlp';

// ফাইল সিস্টেম ব্রেকিং ক্যারেক্টার ক্লিন করার ফাংশন
function sanitizeFilename(title) {
    if (!title) return 'video_' + Date.now();
    let sanitized = title.replace(/[^\w\s\u0980-\u09FF-]/gi, ''); // বাংলা, ইংরেজি বর্ণ ও সংখ্যা অনুমতি দেওয়া হলো
    sanitized = sanitized.trim().replace(/\s+/g, ' ');
    if (!sanitized) return 'video_' + Date.now();
    return sanitized;
}

// নোটিফিকেশনের জন্য ইমেজ বা থাম্বনেইল ডাউনলোড করার হেল্পার
function downloadThumbnail(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => {}); 
            reject(err);
        });
    });
}

// Render-এর মতো ক্লাউড সার্ভারে yt-dlp অটো-ডাউনলোড করার ফাংশন
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        function get(targetUrl) {
            https.get(targetUrl, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    get(response.headers.location);
                } else if (response.statusCode === 200) {
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close(resolve);
                    });
                } else {
                    reject(new Error(`Status code: ${response.statusCode}`));
                }
            }).on('error', (err) => {
                fs.unlink(destPath, () => {});
                reject(err);
            });
        }
        get(url);
    });
}

// yt-dlp ইনস্টলেশন ও রানটাইম নিশ্চিত করার ফাংশন
function checkYtdlp() {
    return new Promise((resolve) => {
        exec('yt-dlp --version', (err) => {
            if (err) {
                const localBinDir = path.join(__dirname, 'bin');
                const localYtDlp = path.join(localBinDir, 'yt-dlp');
                
                if (fs.existsSync(localYtDlp)) {
                    YTDLP_PATH = localYtDlp;
                    resolve();
                } else {
                    if (!fs.existsSync(localBinDir)) {
                        fs.mkdirSync(localBinDir, { recursive: true });
                    }
                    console.log("Render/Linux এনভায়রনমেন্ট শনাক্ত হয়েছে। yt-dlp বাইনারি ডাউনলোড হচ্ছে...");
                    const downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
                    
                    downloadFile(downloadUrl, localYtDlp)
                        .then(() => {
                            fs.chmodSync(localYtDlp, 0o755); // এক্সিকিউটেবল পারমিশন দেওয়া হলো
                            YTDLP_PATH = localYtDlp;
                            console.log("yt-dlp বাইনারি ডাউনলোড ও সেটআপ সম্পন্ন হয়েছে!");
                            resolve();
                        })
                        .catch((downloadErr) => {
                            console.error("yt-dlp ডাউনলোড করতে ব্যর্থ:", downloadErr);
                            resolve(); 
                        });
                }
            } else {
                console.log("সিস্টেমের গ্লোবাল yt-dlp ব্যবহার করা হচ্ছে।");
                resolve();
            }
        });
    });
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
app.use('/videos', express.static(downloadsDir));

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

    const args = [
        '-j', 
        '--extractor-args', 'youtube:player_client=android,web',
        videoUrl
    ];

    // কুকিজ ফাইল থাকলে স্বয়ংক্রিয়ভাবে যোগ করা হবে
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) {
        args.push('--cookies', cookiesPath);
    }

    const ytDlp = spawn(YTDLP_PATH, args);
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

// ৪. ক্যাশ মেমোরি নিয়ন্ত্রিত হাই-স্পীড রেঞ্জ প্রক্সি স্ট্রিম (প্লেব্যাক ও কাটা-কাটি ফিক্স)
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
            let format = '18/best[ext=mp4]/best';
            if (quality === '1080p') format = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best';
            if (quality === '720p') format = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best';
            if (quality === '480p') format = 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best';
            if (quality === '360p') format = '18/best[height<=360][ext=mp4]/best';

            const args = [
                '-f', format, 
                '--no-playlist', 
                '--no-warnings', 
                '--ignore-errors', 
                '--extractor-args', 'youtube:player_client=android,web',
                '-g', 
                videoUrl
            ];

            const cookiesPath = path.join(__dirname, 'cookies.txt');
            if (fs.existsSync(cookiesPath)) {
                args.push('--cookies', cookiesPath);
            }

            directUrl = await getDirectUrlWithArgs(args);
            streamCache[cacheKey] = {
                directUrl: directUrl,
                expiry: Date.now() + (1000 * 60 * 60) 
            };
        } catch (err) {
            return res.status(500).send('Streaming resolution failed: ' + err.message);
        }
    }

    // রেঞ্জ রিকোয়েস্ট ও আইপি লক বাইপাস করতে হাই-স্পিড সার্ভার প্রক্সি
    try {
        const parsedUrl = new URL(directUrl);
        const headers = {};
        
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }
        headers['User-Agent'] = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

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
        if (!res.headersSent) res.status(500).send('Proxy stream failed');
    }
});

function getDirectUrlWithArgs(args) {
    return new Promise((resolve, reject) => {
        const ytDlp = spawn(YTDLP_PATH, args);
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

// ৫. ভিডিওর আসল নাম এবং নোটিফিকেশন সমৃদ্ধ প্রসেস ডাউনলোড এপিআই
app.get('/api/download-start', async (req, res) => {
    const videoUrl = req.query.url;
    const quality = req.query.quality || '360p';
    const clientTitle = req.query.title || 'video_' + Date.now();
    const thumbnailExtUrl = req.query.thumbnail;

    if (!videoUrl) return res.status(400).json({ error: 'URL is required' });

    const safeTitle = sanitizeFilename(clientTitle);
    const downloadId = 'dl_' + Date.now();

    downloadsInProgress[downloadId] = {
        status: 'downloading',
        percent: 0,
        totalSize: 'Calculating...',
        speed: '0 KB/s',
        fileName: ''
    };

    let format = 'best[ext=mp4]/best';
    if (quality === '1080p') format = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    if (quality === '720p') format = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    if (quality === '480p') format = 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
    if (quality === '360p') format = 'best[height<=360][ext=mp4]/best';
    if (quality === 'audio_high' || quality === 'audio') format = 'ba[ext=m4a]/bestaudio';

    const ext = (quality === 'audio' || quality === 'audio_high') ? 'm4a' : 'mp4';
    
    // ভিডিওর আসল টাইটেল যুক্ত করে ফোল্ডার পাথ তৈরি
    const outputTemplate = path.join(downloadsDir, `${safeTitle}.${ext}`);

    // নোটিফিকেশনের থাম্বনেইল ডাউনলোড করার জন্য ব্যাকগ্রাউন্ড পাথ প্রিপারেশন
    const cachedThumbPath = path.join(downloadsDir, `${safeTitle}_thumb.jpg`);
    if (thumbnailExtUrl && thumbnailExtUrl.startsWith('http')) {
        downloadThumbnail(thumbnailExtUrl, cachedThumbPath).catch(() => {});
    }

    const args = [
        '-f', format, 
        '--extractor-args', 'youtube:player_client=android,web',
        '-o', outputTemplate, 
        videoUrl
    ];

    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) {
        args.push('--cookies', cookiesPath);
    }

    const ytDlp = spawn(YTDLP_PATH, args);

    downloadsInProgress[downloadId].process = ytDlp;

    ytDlp.stdout.on('data', (data) => {
        const text = data.toString();
        const progressMatch = text.match(/\[download\]\s+([\d.]+)%\s+of\s+([\d.\w]+)\s+at\s+([\d.\w/]+)/);
        if (progressMatch) {
            downloadsInProgress[downloadId].percent = parseFloat(progressMatch[1]);
            downloadsInProgress[downloadId].totalSize = progressMatch[2];
            downloadsInProgress[downloadId].speed = progressMatch[3];
        }
    });

    ytDlp.on('close', (code) => {
        if (code === 0) {
            const downloadedFileName = `${safeTitle}.${ext}`;
            downloadsInProgress[downloadId].status = 'completed';
            downloadsInProgress[downloadId].fileName = downloadedFileName;

            // শুধুমাত্র অ্যান্ড্রয়েড/টার্মাক্স ডিভাইসে থাকলে গ্যালারি স্ক্যানার ও নোটিফিকেশন রান করবে
            const isAndroid = downloadsDir.includes('shared') || downloadsDir.includes('sdcard');
            
            if (isAndroid) {
                const fullPath = path.join(downloadsDir, downloadedFileName);
                exec(`termux-media-scan "${fullPath}"`, (scanErr) => {
                    if (scanErr) console.log("termux-media-scan failed or not installed:", scanErr);
                });

                // নোটিফিকেশন প্রদর্শন
                let notificationCmd = `termux-notification --title "Minitube ডাউনলোড সম্পন্ন" --content "${safeTitle}" --id "${downloadId}"`;
                if (fs.existsSync(cachedThumbPath)) {
                    notificationCmd += ` --image-path "${cachedThumbPath}"`;
                }
                exec(notificationCmd, (notifErr) => {
                    if (notifErr) console.log("termux-api notification error:", notifErr);
                });
            } else {
                console.log(`ডাউনলোড সম্পন্ন হয়েছে (ক্লাউড সার্ভার): ${downloadedFileName}`);
            }

        } else {
            downloadsInProgress[downloadId].status = 'failed';
        }
    });

    res.json({ downloadId });
});

// ৬. ডাউনলোডের রিয়েল-টাইম স্ট্যাটাস
app.get('/api/download-status', (req, res) => {
    const id = req.query.id;
    if (!id || !downloadsInProgress[id]) {
        return res.status(404).json({ error: 'Download task not found' });
    }
    const task = downloadsInProgress[id];
    res.json({
        status: task.status,
        percent: task.percent,
        totalSize: task.totalSize,
        speed: task.speed,
        fileName: task.fileName
    });
});

// ৭. লোকাল ফাইল মিডিয়াতে পাঠানো
app.get('/api/get-file', (req, res) => {
    const fileName = req.query.file;
    if (!fileName) return res.status(400).send('File name is required');
    
    const safeName = path.basename(fileName);
    const filePath = path.join(downloadsDir, safeName);

    if (fs.existsSync(filePath)) {
        res.download(filePath, safeName);
    } else {
        res.status(404).send('File not found');
    }
});

// yt-dlp সার্চ মেথড
function searchYouTube(query) {
    return new Promise((resolve, reject) => {
        const args = [
            `ytsearch20:${query}`,
            '--flat-playlist',
            '--dump-single-json',
            '--no-warnings',
            '--ignore-errors',
            '--extractor-args', 'youtube:player_client=android,web'
        ];

        const cookiesPath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(cookiesPath)) {
            args.push('--cookies', cookiesPath);
        }

        const ytDlp = spawn(YTDLP_PATH, args);

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

// প্রথমে yt-dlp এনভায়রনমেন্ট চেক বা ডাউনলোড করা হবে, তারপর সার্ভার লিসেন করবে
checkYtdlp().then(() => {
    app.listen(PORT, () => {
        const localIp = getLocalIpAddress();
        console.log("====================================================");
        console.log("🚀 সার্ভার সফলভাবে চালু হয়েছে!");
        console.log("💻 লোকাল: http://localhost:" + PORT);
        console.log("📂 ডাউনলোড পাথ: " + downloadsDir);
        if (localIp) {
            console.log("📱 মোবাইল: http://" + localIp + ":" + PORT);
        } else {
            console.log("📱 মোবাইল: (ওয়াইফাই ডিসকানেক্টেড/ক্লাউড রান)");
        }
        console.log("====================================================");
    });
});
