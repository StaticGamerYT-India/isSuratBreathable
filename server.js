const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const port = 3000;
const IMD_SURAT_URL = 'https://mausam.imd.gov.in/imd_latest/contents/districtwisewarnings_mc.php?id=9';
const NDMA_SURAT_ALERTS_URL = 'https://sachet.ndma.gov.in/cap_public_website/FetchLocationWiseAlerts';
const SURAT_ALERT_QUERY = {
  lat: '21.1702',
  long: '72.8311',
  radius: '250',
};

function buildHeaders(baseHeaders, cookie) {
  if (!cookie) {
    return baseHeaders;
  }
  return {
    ...baseHeaders,
    cookie,
  };
}

function setNoStoreHeaders(res) {
  res.set({
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
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

function parseDateOrZero(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function parseNdmaTimestamp(value) {
  if (!value) {
    return null;
  }

  const cleaned = String(value).trim();
  const match = cleaned.match(/^(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(?:IST|UTC|GMT)\s+(\d{4})$/i);

  if (match) {
    const [, , monthName, day, hour, minute, second, year] = match;
    const monthIndex = new Date(`${monthName} 1, ${year}`).getMonth();
    const parsed = new Date(Date.UTC(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second)));
    return /ist/i.test(cleaned) ? parsed.getTime() - (5 * 60 + 30) * 60 * 1000 : parsed.getTime();
  }

  const directDate = new Date(cleaned);
  if (!Number.isNaN(directDate.getTime())) {
    return directDate.getTime();
  }

  const slashMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (slashMatch) {
    const [, day, month, year, hour, minute] = slashMatch;
    const parsed = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:00+05:30`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getTime();
    }
  }

  return null;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .trim();
}

function toIstDateKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function isCurrentDayNdmaAlert(alert, referenceTime) {
  const startTime = parseNdmaTimestamp(alert.effective_start_time || alert.published || alert.pubDate);
  const endTime = parseNdmaTimestamp(alert.effective_end_time || alert.published || alert.pubDate);
  const candidateTime = startTime || endTime;

  if (!candidateTime) {
    return false;
  }

  const now = referenceTime ? new Date(referenceTime).getTime() : Date.now();
  const currentDay = toIstDateKey(now);
  return toIstDateKey(candidateTime) === currentDay;
}

function getNdmaTone(alert) {
  const severity = normalizeText(alert.severity || alert.severity_level || alert.alert_level || alert.type || alert.disaster_type);
  const disasterType = normalizeText(alert.disaster_type || alert.type || alert.alert_type);
  const message = normalizeText(alert.warning_message || alert.area_description || alert.alert_source);

  if (/red|critical|extreme|urgent|evacuation|severe/.test(severity) || /red|critical|extreme|urgent|evacuation|severe/.test(message) || /tsunami|earthquake|cyclone|flood/.test(disasterType)) {
    return 'red';
  }

  if (/alert|orange|moderate|advisory|storm|thunderstorm|heat|landslide/.test(severity) || /heat|storm|landslide/.test(disasterType)) {
    return 'orange';
  }

  if (/watch|yellow|inform|statement|minor/.test(severity)) {
    return 'yellow';
  }

  return 'neutral';
}

function getCurrentDayNdmaAlerts(alerts, referenceTime) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return [];
  }

  const now = referenceTime ? new Date(referenceTime).getTime() : Date.now();

  return alerts
    .filter(Boolean)
    .map(alert => ({
      ...alert,
      startTime: parseNdmaTimestamp(alert.effective_start_time || alert.published || alert.pubDate),
      endTime: parseNdmaTimestamp(alert.effective_end_time || alert.published || alert.pubDate),
      tone: getNdmaTone(alert),
    }))
    .filter(alert => alert.startTime !== null)
    .filter(alert => toIstDateKey(alert.startTime) === toIstDateKey(now))
    .filter(alert => alert.startTime <= now)
    .sort((left, right) => right.startTime - left.startTime)
    .filter(alert => {
      const text = `${alert.warning_message || ''} ${alert.area_description || ''} ${alert.alert_source || ''}`.toLowerCase();
      return text.includes('surat') || text.includes('gujarat') || text.includes('daman') || text.includes('valsad') || text.includes('navsari') || text.includes('bharuch');
    });
}

async function fetchGujaratRssAlerts() {
  try {
    const response = await fetch('https://sachet.ndma.gov.in/cap_public_website/rss/rss_gujarat.xml', {
      headers: {
        accept: 'application/rss+xml, application/xml, text/xml, */*',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      return [];
    }

    const xml = await response.text();
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/gi);
    const rssItems = [];

    for (const match of itemMatches) {
      const block = match[1] || '';
      const title = block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '';
      const link = block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '';
      const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || '';
      const author = block.match(/<author>([\s\S]*?)<\/author>/i)?.[1] || '';
      const guid = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] || '';

      if (!title) {
        continue;
      }

      rssItems.push({
        identifier: guid || link,
        effective_start_time: pubDate,
        effective_end_time: pubDate,
        warning_message: title.replace(/<[^>]+>/g, ''),
        area_description: title.replace(/<[^>]+>/g, ''),
        alert_source: author || 'NDMA Gujarat RSS',
        actual_lang: 'en',
        severity: /heavy|severe|red|extreme|warning|evacuation/i.test(title) ? 'RED' : /moderate|orange|advisory|alert/i.test(title) ? 'ORANGE' : 'WATCH',
        disaster_type: 'Met',
        type: 'Met',
        published: pubDate,
      });
    }

    return rssItems;
  } catch (error) {
    console.error('Failed to fetch Gujarat RSS alerts:', error);
    return [];
  }
}

function getFallbackWeatherAlert() {
  return {
    district: 'SURAT',
    sourceUrl: IMD_SURAT_URL,
    id: null,
    title: 'SURAT',
    color: '#FFFF00',
    level: 'Yellow Alert',
    tone: 'yellow',
    description: 'Stay aware and follow updates',
    summary: 'Weather data is temporarily unavailable. Please try again shortly.',
    issuedDate: '',
    issuedTime: '',
    validUntil: '',
    info: '',
    balloonText: '',
  };
}

function getFallbackNdmaResponse() {
  return {
    sourceUrl: NDMA_SURAT_ALERTS_URL,
    channelTitle: 'Gujarat: CAP Disaster Alert Feeds',
    currentItem: null,
    hasTodayAlert: false,
    items: [],
  };
}

app.get('/api/weather-alert', async (req, res) => {
  try {
    setNoStoreHeaders(res);

    const imdUrl = new URL(IMD_SURAT_URL);
    imdUrl.searchParams.set('_', String(Date.now()));

    const response = await fetch(imdUrl.toString(), {
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
    console.error('weather-alert route failed:', error);
    res.json(getFallbackWeatherAlert());
  }
});

app.get('/api/ndma-alerts', async (req, res) => {
  try {
    setNoStoreHeaders(res);

    const url = new URL(NDMA_SURAT_ALERTS_URL);
    Object.entries(SURAT_ALERT_QUERY).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    url.searchParams.set('_', String(Date.now()));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`RSS request failed with status ${response.status}`);
    }

    const json = await response.json();
    const locationAlerts = Array.isArray(json.alerts) ? json.alerts : [];
    const rssAlerts = await fetchGujaratRssAlerts();
    const referenceTime = Number(req.query.now || Date.now());
    const combinedAlerts = [...locationAlerts, ...rssAlerts];
    const currentDayAlerts = getCurrentDayNdmaAlerts(combinedAlerts, referenceTime);
    const latestAlert = currentDayAlerts[0] || null;

    res.json({
      sourceUrl: NDMA_SURAT_ALERTS_URL,
      channelTitle: 'Gujarat: CAP Disaster Alert Feeds',
      currentItem: latestAlert,
      hasTodayAlert: currentDayAlerts.length > 0,
      items: currentDayAlerts,
    });
  } catch (error) {
    console.error('ndma-alerts route failed:', error);
    res.json(getFallbackNdmaResponse());
  }
});

module.exports = {
  parseNdmaTimestamp,
  toIstDateKey,
};

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
    console.error('airquality route failed:', error);
    res.json({ data: null, statusText: 'OK', responseText: null, status: 200, redirectUrl: null, iTotalRecords: 0, iTotalDisplayRecords: 0 });
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
    console.error('airquality history route failed:', error);
    res.json({ data: [] });
  }
});

// Start the server only when running this file directly.
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
  });
}

module.exports = app;
module.exports.parseNdmaTimestamp = parseNdmaTimestamp;
module.exports.toIstDateKey = toIstDateKey;
module.exports.getCurrentDayNdmaAlerts = getCurrentDayNdmaAlerts;
