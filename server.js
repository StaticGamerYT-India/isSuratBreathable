const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const port = 3000;
const IMD_SURAT_URL = 'https://mausam.imd.gov.in/imd_latest/contents/districtwisewarnings_mc.php?id=9';
const NDMA_GUJARAT_RSS_URL = 'https://sachet.ndma.gov.in/cap_public_website/rss/rss_gujarat.xml';

function buildHeaders(baseHeaders, cookie) {
  if (!cookie) {
    return baseHeaders;
  }
  return {
    ...baseHeaders,
    cookie,
  };
}

function extractObjectForTitle(html, title) {
  const searchIndex = html.indexOf(`"title": "${title}"`);

  if (searchIndex === -1) {
    throw new Error(`Could not find ${title} in IMD response`);
  }

  const objectStart = html.lastIndexOf('{', searchIndex);

  if (objectStart === -1) {
    throw new Error(`Could not locate the start of the ${title} object`);
  }

  let depth = 0;

  for (let index = objectStart; index < html.length; index += 1) {
    const character = html[index];

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;

      if (depth === 0) {
        const objectText = html.slice(objectStart, index + 1);
        return JSON.parse(objectText);
      }
    }
  }

  throw new Error(`Could not parse the ${title} object from the IMD response`);
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>(?!\n)/gi, '\n')
    .replace(/<\/br>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<p>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map(part => part.trim())
    .filter(Boolean);
}

function getAlertMeta(color) {
  const normalizedColor = String(color || '').trim().toLowerCase();

  switch (normalizedColor) {
    case '#ff0000':
      return {
        level: 'Red Alert',
        tone: 'red',
        description: 'Severe weather warning',
      };
    case '#ffa500':
      return {
        level: 'Orange Alert',
        tone: 'orange',
        description: 'Be prepared for significant weather',
      };
    case '#ffff00':
      return {
        level: 'Yellow Alert',
        tone: 'yellow',
        description: 'Stay aware and follow updates',
      };
    case '#008000':
      return {
        level: 'No Warning',
        tone: 'green',
        description: 'No active district warning',
      };
    default:
      return {
        level: 'Weather Alert',
        tone: 'neutral',
        description: 'District-wise weather warning',
      };
  }
}

function parseAlertDetails(info) {
  const lines = stripHtml(info);
  const summary = lines.filter(line => !/^Time of issue:/i.test(line) && !/^Valid upto:/i.test(line));
  const issuedDateLineIndex = lines.findIndex(line => /^Time of issue:/i.test(line));
  const validDateLineIndex = lines.findIndex(line => /^Valid upto:/i.test(line));

  const issuedDate = issuedDateLineIndex >= 0
    ? lines[issuedDateLineIndex].replace(/^Time of issue:\s*/i, '').trim()
    : '';

  const issuedTime = issuedDateLineIndex >= 0 && lines[issuedDateLineIndex + 1]
    ? lines[issuedDateLineIndex + 1]
    : '';

  const validUntil = validDateLineIndex >= 0
    ? lines[validDateLineIndex].replace(/^Valid upto:\s*/i, '').trim()
    : '';

  return {
    summary: summary.join(' '),
    issuedDate,
    issuedTime,
    validUntil,
    lines,
  };
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function extractTagValue(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\/${tagName}>`, 'i'));

  if (!match) {
    return '';
  }

  return decodeXmlEntities(match[1].replace(/<[^>]+>/g, ' '));
}

function parseRssItems(xml) {
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

  return itemBlocks.map(block => ({
    title: extractTagValue(block, 'title'),
    description: extractTagValue(block, 'description'),
    link: extractTagValue(block, 'link'),
    category: extractTagValue(block, 'category'),
    author: extractTagValue(block, 'author'),
    guid: extractTagValue(block, 'guid'),
    pubDate: extractTagValue(block, 'pubDate'),
  }));
}

function mentionsSurat(item) {
  return /surat/i.test(`${item?.title || ''} ${item?.description || ''}`);
}

function getDateKeyInTimeZone(dateValue, timeZone = 'Asia/Kolkata') {
  const date = new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getTodayDateKeyInTimeZone(timeZone = 'Asia/Kolkata') {
  return getDateKeyInTimeZone(new Date(), timeZone);
}

app.get('/api/weather-alert', async (req, res) => {
  try {
    const response = await fetch(IMD_SURAT_URL, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`IMD request failed with status ${response.status}`);
    }

    const html = await response.text();
    const alert = extractObjectForTitle(html, 'SURAT');
    const meta = getAlertMeta(alert.color);
    const details = parseAlertDetails(alert.info);

    res.json({
      district: 'SURAT',
      sourceUrl: IMD_SURAT_URL,
      id: alert.id,
      title: alert.title,
      color: alert.color,
      level: meta.level,
      tone: meta.tone,
      description: meta.description,
      summary: details.summary,
      issuedDate: details.issuedDate,
      issuedTime: details.issuedTime,
      validUntil: details.validUntil,
      info: alert.info,
      balloonText: alert.balloonText,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error fetching weather alert data' });
  }
});

app.get('/api/rss-alerts', async (req, res) => {
  try {
    const response = await fetch(NDMA_GUJARAT_RSS_URL, {
      headers: {
        accept: 'application/rss+xml,application/xml,text/xml,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`RSS request failed with status ${response.status}`);
    }

    const xml = await response.text();
    const items = parseRssItems(xml);
    const todayKey = getTodayDateKeyInTimeZone('Asia/Kolkata');
    const todaysSuratItem = items.find(item => getDateKeyInTimeZone(item.pubDate, 'Asia/Kolkata') === todayKey && mentionsSurat(item)) || null;

    res.json({
      sourceUrl: NDMA_GUJARAT_RSS_URL,
      channelTitle: 'Gujarat: CAP Disaster Alert Feeds',
      currentItem: todaysSuratItem,
      hasTodayAlert: Boolean(todaysSuratItem),
      items: todaysSuratItem ? [todaysSuratItem] : [],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error fetching RSS alerts data' });
  }
});

app.use(express.static(__dirname));

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, '/', 'index.html'));
});

app.get('/api/airquality', async (req, res) => {
  try {
    // First, fetch the page to get a valid session cookie
    const initialResponse = await fetch("https://www.suratmunicipal.gov.in/Departments/AirQualityResults");
    const cookie = initialResponse.headers.get('set-cookie');

    let apiRes = await fetch("https://www.suratmunicipal.gov.in/Home/GetAirQualityInfoSci", {
      "headers": buildHeaders({
        "accept": "*/*",
        "accept-language": "en-GB,en;q=0.9",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "priority": "u=1, i",
        "sec-ch-ua": "\"Microsoft Edge\";v=\"137\", \"Chromium\";v=\"137\", \"Not/A)Brand\";v=\"24\"",
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": "\"Android\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-requested-with": "XMLHttpRequest",
        "Referer": "https://www.suratmunicipal.gov.in/Departments/AirQualityResults",
        "Referrer-Policy": "strict-origin-when-cross-origin"
      }, cookie),
      "body": "DeviceCode=",
      "method": "POST"
    });

    let data = await apiRes.json();
    console.log('Data from API:', JSON.stringify(data, null, 2));
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error fetching air quality data');
  }
});

app.get('/api/airquality/history', async (req, res) => {
  try {
    // First, fetch the page to get a valid session cookie
    const initialResponse = await fetch("https://www.suratmunicipal.gov.in/Departments/AirQualityResults");
    const cookie = initialResponse.headers.get('set-cookie');

    let apiRes = await fetch("https://www.suratmunicipal.gov.in/Home/GetAirQualityInfoSciLast10", {
      "headers": buildHeaders({
        "accept": "*/*",
        "accept-language": "en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "priority": "u=1, i",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-requested-with": "XMLHttpRequest",
        "Referer": "https://www.suratmunicipal.gov.in/Departments/AirQualityResults",
        "Referrer-Policy": "strict-origin-when-cross-origin"
      }, cookie),
      "body": "DeviceCode=",
      "method": "POST"
    });

    let data = await apiRes.json();
    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error fetching historical air quality data');
  }
});

// Start the server only when running this file directly.
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
  });
}

module.exports = app;
