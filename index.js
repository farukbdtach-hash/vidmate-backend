const express = require('express');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');

const app = express();
const PORT = 3000;

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
const streamCache = {}; // এক্সট্র্যাক্ট করা স্ট্রিমিং লিঙ্ক ক্যাশ

// ব্যাকগ্রাউন্ড প্রি-ফেচ কিউ (ফোন অতিরিক্ত ল্যাগ হওয়া থেকে রক্ষা করতে)
let prefetchQueue = [];
let isPrefetching = false;

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

// yt-dlp থেকে সরাসরি এবং অত্যন্ত দ্রুত স্ট্রিমিং লিঙ্ক এক্সট্র্যাক্ট করার কোর হেল্পার
function getDirectStreamUrl(videoUrl, quality) {
    return new Promise((resolve, reject) => {
        let format = '18/best[ext=mp4]/best';
        if (quality === '1080p') format = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best';
        if (quality === '720p') format = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best';
        if (quality === '480p') format = 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best';
        if (quality === '360p') format = '18/best[height<=360][ext=mp4]/best';

        // সুপার-ফাস্ট প্যারামিটার (কনফিগ ফাইল এবং ভারী ম্যানিফেস্ট স্কিপ করা হয়েছে)
        const ytDlp = spawn('yt-dlp', [
            '-f', format, 
            '--no-playlist', 
            '--no-warnings', 
            '--ignore-errors', 
            '--no-config',                    // টার্মিনাল কনফিগ লোড স্কিপ করবে
            '--no-check-certificate',          // SSL চেক বাইপাস করে কানেকশন দ্রুত করবে
            '--youtube-skip-dash-manifest',    // DASH ম্যানিফেস্ট প্রসেসিং স্কিপ
            '--youtube-skip-hls-manifest',     // HLS ম্যানিফেস্ট প্রসেসিং স্কিপ
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

// সিকুয়েনশিয়াল ব্যাকগ্রাউন্ড প্রি-ফেচিং রানার (মোবাইলের চার্জ ও র‍্যাম সুরক্ষিত রাখবে)
async function processPrefetchQueue() {
    if (isPrefetching || prefetchQueue.length === 0) return;
    isPrefetching = true;

    while (prefetchQueue.length > 0) {
        const item = prefetchQueue.shift();
        const cacheKey = `${item.url}_${item.quality}`;

        if (streamCache[cacheKey] && streamCache[cacheKey].expiry > Date.now()) {
            continue; // ইতোমধ্যে ক্যাশে থাকলে স্কিপ করবে
        }

        try {
            console.log(`[Prefetching Video Link]: ${item.title.substring(0, 30)}...`);
            const directUrl = await getDirectStreamUrl(item.url, item.quality);
            if (directUrl) {
                streamCache[cacheKey] = {
                    directUrl: directUrl,
                    expiry: Date.now() + (1000 * 60 * 60 * 3) // ৩ ঘণ্টার জন্য মেমোরিতে থাকবে
                };
                console.log(`[Prefetched & Cached Successfully]: ${item.title.substring(0, 30)}`);
            }
        } catch (e) {
            console.log(`[Prefetch Ignored]: ${item.title.substring(0, 20)} - ${e.message}`);
        }

        // সিকিউরিটি বাফার পজ (যাতে টার্মিনাল ল্যাগ না করে)
        await new Promise(resolve => setTimeout(resolve, 1500));
    }

    isPrefetching = false;
}

// প্রি-ফেচ তালিকায় সার্চের ভিডিওগুলো যুক্ত করার ফাংশন
function triggerPrefetch(videos) {
    // শুধুমাত্র প্রথম ৪টি রেজাল্ট প্রি-ফেচ তালিকায় যুক্ত করা হবে (সবচেয়ে বেশি ক্লিক হওয়ার সম্ভাবনা যেগুলোতে থাকে)
    videos.forEach(video => {
        prefetchQueue.push({
            url: video.url,
            title: video.title,
            quality: '360p' // ডিফল্ট হোম প্লেব্যাক কোয়ালিটি
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

        // ব্যাকগ্রাউন্ডে গোপনে প্রথম ৩-৪টি ভিডিওর লিঙ্ক ক্যাশ করা শুরু করবে
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

// ৪. ক্যাশ মেমোরি নিয়ন্ত্রিত হাই-স্পীড প্লেব্যাক স্ট্রিম
app.get('/api/stream', async (req, res) => {
    const videoUrl = req.query.url;
    const quality = req.query.quality || '360p';
    if (!videoUrl) return res.status(400).send('URL is required');

    const cacheKey = `${videoUrl}_${quality}`;
    
    // ক্যাশ চেক (যদি ভিডিও আগে ব্যাকগ্রাউন্ডে প্রি-ফেচ হয়ে থাকে, তবে এটি ইনস্ট্যান্টলি প্লে হবে)
    if (streamCache[cacheKey] && streamCache[cacheKey].expiry > Date.now()) {
        console.log(`[Cache Hit] Serving video link instantly for: ${videoUrl}`);
        return res.redirect(302, streamCache[cacheKey].directUrl);
    }

    // ক্যাশ মিস হলে অন-ডিমান্ড দ্রুত স্ট্রিমিং লিঙ্ক এক্সট্র্যাক্ট করবে
    try {
        console.log(`[Cache Miss] Fetching link on-demand: ${videoUrl}`);
        const streamDirectUrl = await getDirectStreamUrl(videoUrl, quality);
        
        streamCache[cacheKey] = {
            directUrl: streamDirectUrl,
            expiry: Date.now() + (1000 * 60 * 60 * 3) // ৩ ঘণ্টা ক্যাশ
        };

        res.redirect(302, streamDirectUrl);
    } catch (err) {
        res.status(500).send('Streaming failed: ' + err.message);
    }
});

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
    
    // ডুপ্লিকেট ডাউনলোড প্রতিরোধ চেক
    let downloadedFileName = `${safeTitle}.${ext}`;
    let outputTemplate = path.join(downloadsDir, downloadedFileName);
    if (fs.existsSync(outputTemplate)) {
        const uniqueSuffix = Math.floor(Date.now() / 1000);
        downloadedFileName = `${safeTitle}_${uniqueSuffix}.${ext}`;
        outputTemplate = path.join(downloadsDir, downloadedFileName);
    }

    // নোটিফিকেশনের থাম্বনেইল ডাউনলোড করার জন্য ব্যাকগ্রাউন্ড পাথ প্রিপারেশন
    const cachedThumbPath = path.join(downloadsDir, `${safeTitle}_thumb.jpg`);
    if (thumbnailExtUrl && thumbnailExtUrl.startsWith('http')) {
        downloadThumbnail(thumbnailExtUrl, cachedThumbPath).catch(() => {});
    }

    const args = [
        '-f', format, 
        '--extractor-args', 'youtube:player_client=default,-android_sdkless',
        '-o', outputTemplate, 
        videoUrl
    ];
    const ytDlp = spawn('yt-dlp', args);

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
            downloadsInProgress[downloadId].status = 'completed';
            downloadsInProgress[downloadId].fileName = downloadedFileName;

            // গ্যালারিতে ভিডিও রিফ্রেশ করার মিডিয়া স্ক্যানার রান
            exec(`termux-media-scan "${outputTemplate}"`, (scanErr) => {
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

// yt-dlp সার্চ মেথড (অপ্টিমাইজড স্পীড প্যারামিটার সহ)
function searchYouTube(query) {
    return new Promise((resolve, reject) => {
        const ytDlp = spawn('yt-dlp', [
            `ytsearch20:${query}`,
            '--flat-playlist',
            '--dump-single-json',
            '--no-warnings',
            '--ignore-errors',
            '--no-config',                     // কনফিগ স্কিপ
            '--no-check-certificate',           // SSL চেক স্কিপ
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
    console.log("🚀 অপ্টিমাইজড স্ট্রিমিং সার্ভার সফলভাবে চালু হয়েছে!");
    console.log("💻 লোকাল: http://localhost:" + PORT);
    console.log("📂 ডাউনলোড পাথ: " + downloadsDir);
    if (localIp) {
        console.log("📱 মোবাইল: http://" + localIp + ":" + PORT);
    } else {
        console.log("📱 মোবাইল: (ওয়াইফাই ডিসকানেক্টেড)");
    }
    console.log("====================================================");
});
