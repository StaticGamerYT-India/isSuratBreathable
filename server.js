const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const port = 3000;
const UPSTREAM_TIMEOUT_MS = 10000;
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

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

function sendServiceUnavailable(res, message) {
  setNoStoreHeaders(res);
  res.status(503).json({ error: message });
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function coerceNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const US_AQI_BREAKPOINTS = {
  pm25: [
    [0, 9.0, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
    [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 400],
    [325.5, 500.4, 401, 500],
  ],
  pm10: [
    [0, 54, 0, 50], [55, 154, 51, 100], [155, 254, 101, 150],
    [255, 354, 151, 200], [355, 424, 201, 300], [425, 504, 301, 400],
    [505, 604, 401, 500],
  ],
  so2: [
    [0, 0.035, 0, 50], [0.036, 0.075, 51, 100], [0.076, 0.185, 101, 150],
    [0.186, 0.304, 151, 200], [0.305, 0.604, 201, 300], [0.605, 0.804, 301, 400],
    [0.805, 1.004, 401, 500],
  ],
  co: [
    [0, 4.4, 0, 50], [4.5, 9.4, 51, 100], [9.5, 12.4, 101, 150],
    [12.5, 15.4, 151, 200], [15.5, 30.4, 201, 300], [30.5, 40.4, 301, 400],
    [40.5, 50.4, 401, 500],
  ],
};

const INDIA_NAQI_BREAKPOINTS = {
  pm25: [
    [0, 30, 0, 50], [31, 60, 51, 100], [61, 90, 101, 200],
    [91, 120, 201, 300], [121, 250, 301, 400], [251, 500, 401, 500],
  ],
  pm10: [
    [0, 50, 0, 50], [51, 100, 51, 100], [101, 250, 101, 200],
    [251, 350, 201, 300], [351, 430, 301, 400], [431, 1000, 401, 500],
  ],
  so2: [
    [0, 40, 0, 50], [41, 80, 51, 100], [81, 380, 101, 200],
    [381, 800, 201, 300], [801, 1600, 301, 400], [1601, 2000, 401, 500],
  ],
  no2: [
    [0, 40, 0, 50], [41, 80, 51, 100], [81, 180, 101, 200],
    [181, 280, 201, 300], [281, 400, 301, 400], [401, 1000, 401, 500],
  ],
  co: [
    [0, 1, 0, 50], [1.1, 2, 51, 100], [2.1, 10, 101, 200],
    [10.1, 17, 201, 300], [17.1, 34, 301, 400], [34.1, 50, 401, 500],
  ],
};

function calculateSubIndex(value, breakpoints, normalize = number => number) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null;
  }

  const concentration = normalize(numericValue);
  const range = breakpoints.find(([low, high]) => concentration >= low && concentration <= high);
  if (!range) {
    return concentration > breakpoints[breakpoints.length - 1][1] ? 500 : null;
  }

  const [concentrationLow, concentrationHigh, indexLow, indexHigh] = range;
  return Math.round(((indexHigh - indexLow) / (concentrationHigh - concentrationLow))
    * (concentration - concentrationLow) + indexLow);
}

function truncate(value, decimalPlaces) {
  const factor = 10 ** decimalPlaces;
  return Math.floor(value * factor) / factor;
}

function parseStationValue(station, ...keys) {
  for (const key of keys) {
    if (station?.[key] === null || station?.[key] === undefined || String(station[key]).trim() === '') {
      continue;
    }
    const value = Number(station?.[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function buildIndexResult(subIndices, unavailable, caveat) {
  const available = Object.entries(subIndices).filter(([, value]) => value !== null);
  const value = available.length ? Math.max(...available.map(([, index]) => index)) : null;
  const dominant = available.find(([, index]) => index === value)?.[0] || null;

  return {
    value,
    dominant,
    subIndices,
    availablePollutants: available.map(([pollutant]) => pollutant),
    unavailablePollutants: unavailable,
    caveat,
  };
}

function calculateAirQualityIndices(station) {
  const pm25 = parseStationValue(station, 'PM2_5', 'PM25');
  const pm10 = parseStationValue(station, 'PM10');
  const so2 = parseStationValue(station, 'So2', 'SO2');
  const nox = parseStationValue(station, 'NOx');
  const no2 = parseStationValue(station, 'NO2');
  const co = parseStationValue(station, 'CO');
  const usCoPpm = co === null ? null : co / 1145;
  const indiaCoMg = co === null ? null : co / 1000;

  const usSubIndices = {
    pm25: calculateSubIndex(pm25, US_AQI_BREAKPOINTS.pm25, value => truncate(value, 1)),
    pm10: calculateSubIndex(pm10, US_AQI_BREAKPOINTS.pm10, value => Math.floor(value)),
    so2: calculateSubIndex(so2 === null ? null : so2 * 24.45 / (64.066 * 1000), US_AQI_BREAKPOINTS.so2, value => truncate(value, 3)),
    co: calculateSubIndex(usCoPpm, US_AQI_BREAKPOINTS.co, value => truncate(value, 1)),
  };
  const indiaSubIndices = {
    pm25: calculateSubIndex(pm25, INDIA_NAQI_BREAKPOINTS.pm25, value => Math.floor(value)),
    pm10: calculateSubIndex(pm10, INDIA_NAQI_BREAKPOINTS.pm10, value => Math.floor(value)),
    so2: calculateSubIndex(so2, INDIA_NAQI_BREAKPOINTS.so2, value => Math.floor(value)),
    no2: calculateSubIndex(no2, INDIA_NAQI_BREAKPOINTS.no2, value => Math.floor(value)),
    co: calculateSubIndex(indiaCoMg, INDIA_NAQI_BREAKPOINTS.co, value => truncate(value, 1)),
  };

  const indiaUnavailable = ['O3', 'NH3', 'Pb'];
  if (no2 === null && nox !== null) {
    indiaUnavailable.push('NO2 (API reports NOx; not interchangeable)');
  } else if (no2 === null) {
    indiaUnavailable.push('NO2');
  }
  const usUnavailable = ['O3', 'NO2', 'NH3', 'Pb'];
  if (nox !== null) {
    usUnavailable.push('NOx is not an EPA AQI pollutant');
  }

  return {
    usAqi: buildIndexResult(usSubIndices, usUnavailable, 'US AQI requires pollutant averaging periods; this dashboard uses the latest station readings. CO is converted from µg/m³ to ppm using 25°C and 1 atm.'),
    indiaNaqi: buildIndexResult(indiaSubIndices, indiaUnavailable, 'Indian NAQI requires pollutant averaging periods; this dashboard uses the latest station readings. CO is converted from µg/m³ to mg/m³.'),
    units: { pm25: 'µg/m³', pm10: 'µg/m³', so2: 'µg/m³', co: 'µg/m³' },
    excludedMeasurements: ['temperature', 'humidity', 'pressure', 'wind', 'rainfall', 'solar radiation'],
  };
}

function parseHistoryRainfall(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => Number(item))
      .filter(item => Number.isFinite(item))
      .slice(-100);
  }

  if (typeof value === 'string') {
    if (value.length > 4096) {
      return [];
    }

    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.map(item => Number(item)).filter(item => Number.isFinite(item)).slice(-100)
        : [];
    } catch (error) {
      return [];
    }
  }

  return [];
}

function calculateRainProbability({
  temperature,
  humidity,
  pressure,
  recentRainfall,
  windSpeed,
  alertTone,
  historyTrend,
  historyRainfall,
  forecastProbability,
  currentPrecipitation,
  weatherCode,
}) {
  const temp = Number(temperature) || 0;
  const hum = Number(humidity) || 0;
  const pres = Number(pressure) || 0;
  const recentRain = Number(recentRainfall) || 0;
  const wind = Number(windSpeed) || 0;
  const trend = Number(historyTrend) || 0;
  const recentHistory = Array.isArray(historyRainfall) ? historyRainfall : [];
  const latestHistory = recentHistory.length ? recentHistory[recentHistory.length - 1] : 0;
  const previousHistory = recentHistory.length > 1 ? recentHistory[recentHistory.length - 2] : 0;
  const historyDelta = latestHistory - previousHistory;
  const forecast = Number(forecastProbability) || 0;
  const currentPrecip = Number(currentPrecipitation) || 0;
  const code = Number(weatherCode) || 0;
  const alertBias = alertTone === 'red' ? 0.16 : alertTone === 'orange' ? 0.12 : alertTone === 'yellow' ? 0.08 : 0;

  let score = 0;

  if (temp >= 22 && temp <= 32) {
    score += 0.30;
  } else if (temp >= 18 && temp < 22) {
    score += 0.14;
  } else if (temp > 32) {
    score += 0.04;
  } else {
    score -= 0.08;
  }

  if (hum >= 85) {
    score += 0.28;
  } else if (hum >= 70) {
    score += 0.20;
  } else if (hum >= 55) {
    score += 0.10;
  } else {
    score -= 0.06;
  }

  if (pres > 0 && pres < 1004) {
    score += 0.18;
  } else if (pres > 1008) {
    score -= 0.08;
  }

  if (recentRain >= 1.5) {
    score += 0.18;
  } else if (recentRain > 0) {
    score += 0.10;
  }

  if (wind >= 8 && wind <= 20) {
    score += 0.10;
  } else if (wind > 24) {
    score -= 0.06;
  }

  if (trend > 0.2) {
    score += Math.min(0.16, trend / 2.5);
  } else if (trend < -0.2) {
    score -= 0.05;
  }

  if (historyDelta > 0.2) {
    score += 0.05;
  } else if (historyDelta < -0.2) {
    score -= 0.04;
  }

  score += alertBias;
  score += (forecast / 100) * 0.62;
  score += currentPrecip > 0.5 ? 0.12 : currentPrecip > 0 ? 0.04 : 0;

  if ([61, 63, 65, 80, 81, 82].includes(code)) {
    score += 0.16;
  } else if (code === 95 || code === 96 || code === 99) {
    score += 0.22;
  } else if ([0, 1].includes(code)) {
    score -= 0.08;
  }

  const probability = clamp(Math.round((score / 1.82) * 100), 3, 97);

  let label = 'Low chance';
  let tone = '#2e7d32';
  if (probability >= 80) {
    label = 'Very likely';
    tone = '#d32f2f';
  } else if (probability >= 60) {
    label = 'Likely';
    tone = '#fb8c00';
  } else if (probability >= 35) {
    label = 'Possible';
    tone = '#f9a825';
  }

  let explanation = 'The current setup is still mostly dry, with only a weak signal for rain.';
  if (probability >= 80) {
    explanation = 'Rain is strongly supported by the live forecast, high humidity, and ongoing rainfall signals.';
  } else if (probability >= 60) {
    explanation = 'The atmosphere looks favorable for showers, with moisture and forecast support lining up.';
  } else if (probability >= 35) {
    explanation = 'There is a moderate rain signal from the current conditions and the recent trend.';
  } else {
    explanation = 'Rain is not strongly supported right now; the sky and the recent trend are still mostly dry.';
  }

  return { probability, label, tone, explanation };
}

async function fetchOpenMeteoForecast() {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', '21.1702');
    url.searchParams.set('longitude', '72.8311');
    url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m,precipitation,weather_code');
    url.searchParams.set('hourly', 'precipitation_probability');
    url.searchParams.set('timezone', 'Asia/Kolkata');
    url.searchParams.set('forecast_days', '1');

    const response = await fetchWithTimeout(url.toString(), {
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`Forecast request failed with status ${response.status}`);
    }

    const json = await response.json();
    const hourlyProbability = Array.isArray(json?.hourly?.precipitation_probability)
      ? json.hourly.precipitation_probability
      : [];
    const forecastProbability = Number(hourlyProbability[0] ?? json?.daily?.precipitation_probability_mean?.[0] ?? 0);

    return {
      temperature: Number(json?.current?.temperature_2m ?? 0),
      humidity: Number(json?.current?.relative_humidity_2m ?? 0),
      pressure: Number(json?.current?.pressure_msl ?? 0),
      windSpeed: Number(json?.current?.wind_speed_10m ?? 0),
      currentPrecipitation: Number(json?.current?.precipitation ?? 0),
      forecastProbability,
      weatherCode: Number(json?.current?.weather_code ?? 0),
    };
  } catch (error) {
    console.error('Forecast fetch failed:', error);
    return {
      temperature: 0,
      humidity: 0,
      pressure: 0,
      windSpeed: 0,
      currentPrecipitation: 0,
      forecastProbability: 0,
      weatherCode: 0,
    };
  }
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
      sortTime: parseNdmaTimestamp(alert.effective_start_time || alert.published || alert.pubDate) || parseNdmaTimestamp(alert.effective_end_time || alert.published || alert.pubDate),
      tone: getNdmaTone(alert),
    }))
    .filter(alert => alert.startTime !== null)
    .filter(alert => toIstDateKey(alert.startTime) === toIstDateKey(now))
    .filter(alert => alert.startTime <= now)
    .sort((left, right) => (right.sortTime || right.startTime || right.endTime || 0) - (left.sortTime || left.startTime || left.endTime || 0))
    .filter(alert => {
      const text = `${alert.warning_message || ''} ${alert.area_description || ''} ${alert.alert_source || ''}`.toLowerCase();
      return text.includes('surat') || text.includes('gujarat') || text.includes('daman') || text.includes('valsad') || text.includes('navsari') || text.includes('bharuch');
    });
}

async function fetchGujaratRssAlerts() {
  try {
    const response = await fetchWithTimeout('https://sachet.ndma.gov.in/cap_public_website/rss/rss_gujarat.xml', {
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

app.get('/api/weather-alert', async (req, res) => {
  try {
    setNoStoreHeaders(res);

    const imdUrl = new URL(IMD_SURAT_URL);
    imdUrl.searchParams.set('_', String(Date.now()));

    const response = await fetchWithTimeout(imdUrl.toString(), {
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
    sendServiceUnavailable(res, 'Weather alert data is temporarily unavailable.');
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

    const response = await fetchWithTimeout(url, {
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
    sendServiceUnavailable(res, 'Disaster alert data is temporarily unavailable.');
  }
});

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, '/', 'index.html'));
});

app.get('/api/rain-probability', async (req, res) => {
  try {
    setNoStoreHeaders(res);

    const forecast = await fetchOpenMeteoForecast();
    const historyRainfall = parseHistoryRainfall(req.query.historyRainfall);
    const historyTrend = coerceNumber(req.query.historyTrend, historyRainfall.length >= 2
      ? historyRainfall[historyRainfall.length - 1] - historyRainfall[0]
      : 0);

    const result = calculateRainProbability({
      temperature: coerceNumber(req.query.temperature, forecast.temperature),
      humidity: coerceNumber(req.query.humidity, forecast.humidity),
      pressure: coerceNumber(req.query.pressure, forecast.pressure),
      recentRainfall: coerceNumber(req.query.recentRainfall, forecast.currentPrecipitation),
      windSpeed: coerceNumber(req.query.windSpeed, forecast.windSpeed),
      alertTone: String(req.query.alertTone || 'neutral'),
      historyTrend,
      historyRainfall,
      forecastProbability: coerceNumber(req.query.forecastProbability, forecast.forecastProbability),
      currentPrecipitation: coerceNumber(req.query.currentPrecipitation, forecast.currentPrecipitation),
      weatherCode: coerceNumber(req.query.weatherCode, forecast.weatherCode),
    });

    res.json(result);
  } catch (error) {
    console.error('rain-probability route failed:', error);
    res.json({ probability: 15, label: 'Low chance', tone: '#2e7d32', explanation: 'Rain probability is temporarily unavailable.' });
  }
});

app.get('/api/airquality', async (req, res) => {
  try {
    // First, fetch the page to get a valid session cookie
    const initialResponse = await fetchWithTimeout("https://www.suratmunicipal.gov.in/Departments/AirQualityResults");
    if (!initialResponse.ok) {
      throw new Error(`Air quality page request failed with status ${initialResponse.status}`);
    }
    const cookie = initialResponse.headers.get('set-cookie');

    let apiRes = await fetchWithTimeout("https://www.suratmunicipal.gov.in/Home/GetAirQualityInfoSci", {
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
    if (!apiRes.ok) {
      throw new Error(`Air quality request failed with status ${apiRes.status}`);
    }

    let data = await apiRes.json();
    if (data && typeof data === 'object' && data.data && typeof data.data === 'object') {
      data.airQualityIndices = calculateAirQualityIndices(data.data);
    }
    res.json(data);
  } catch (error) {
    console.error('airquality route failed:', error);
    sendServiceUnavailable(res, 'Air quality data is temporarily unavailable.');
  }
});

app.get('/api/airquality/history', async (req, res) => {
  try {
    // First, fetch the page to get a valid session cookie
    const initialResponse = await fetchWithTimeout("https://www.suratmunicipal.gov.in/Departments/AirQualityResults");
    if (!initialResponse.ok) {
      throw new Error(`Air quality history page request failed with status ${initialResponse.status}`);
    }
    const cookie = initialResponse.headers.get('set-cookie');

    let apiRes = await fetchWithTimeout("https://www.suratmunicipal.gov.in/Home/GetAirQualityInfoSciLast10", {
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
    if (!apiRes.ok) {
      throw new Error(`Air quality history request failed with status ${apiRes.status}`);
    }

    let data = await apiRes.json();
    res.json(data);
  } catch (error) {
    console.error('airquality history route failed:', error);
    sendServiceUnavailable(res, 'Air quality history is temporarily unavailable.');
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
module.exports.calculateRainProbability = calculateRainProbability;
module.exports.calculateAirQualityIndices = calculateAirQualityIndices;
