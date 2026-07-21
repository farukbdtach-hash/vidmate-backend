const express = require('express');
const cors = require('cors');
const play = require('play-dl');

const app = express();
app.use(cors());

// ১. সার্চ এপিআই
app.get('/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query is required' });

    const results = await play.search(query, { limit: 20 });
    res.json(results);
  } catch (error) {
    console.error('Search Error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ২. স্ট্রিম এপিআই
app.get('/get-stream-url', async (req, res) => {
  try {
    const videoId = req.query.id;
    if (!videoId) return res.status(400).json({ error: 'Video ID required' });

    const stream = await play.stream(`https://www.youtube.com/watch?v=${videoId}`);
    if (stream && stream.url) {
      res.json({ streamUrl: stream.url });
    } else {
      res.status(404).json({ error: 'Stream URL not found' });
    }
  } catch (error) {
    console.error('Stream Error:', error);
    res.status(500).json({ error: 'Failed to fetch stream' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
