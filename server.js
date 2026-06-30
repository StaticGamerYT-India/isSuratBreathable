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
  radius: '20',
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

app.get('/api/ndma-alerts', async (req, res) => {
  try {
    const url = new URL(NDMA_SURAT_ALERTS_URL);
    Object.entries(SURAT_ALERT_QUERY).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

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
    const alerts = Array.isArray(json.alerts) ? json.alerts : [];
    const currentAlert = alerts
      .filter(alert => /surat/i.test(`${alert.area_description || ''} ${alert.warning_message || ''}`))
      .sort((left, right) => parseDateOrZero(right.effective_start_time) - parseDateOrZero(left.effective_start_time))[0] || null;

    res.json({
      sourceUrl: NDMA_SURAT_ALERTS_URL,
      channelTitle: 'Gujarat: CAP Disaster Alert Feeds',
      currentItem: currentAlert,
      hasTodayAlert: Boolean(currentAlert),
      items: currentAlert ? [currentAlert] : [],
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
