const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateRainProbability } = require('../server');

test('calculateRainProbability rises sharply when forecast and live rain both support it', () => {
  const result = calculateRainProbability({
    temperature: 28,
    humidity: 88,
    pressure: 998,
    recentRainfall: 1.2,
    windSpeed: 12,
    alertTone: 'orange',
    historyTrend: 0.8,
    historyRainfall: [0.2, 0.4, 0.8, 1.2],
    forecastProbability: 85,
    currentPrecipitation: 2.3,
    weatherCode: 61,
  });

  assert.equal(result.probability >= 80, true);
  assert.match(result.explanation.toLowerCase(), /forecast|rain/i);
});

test('calculateRainProbability stays conservative when skies are dry', () => {
  const result = calculateRainProbability({
    temperature: 35,
    humidity: 32,
    pressure: 1016,
    recentRainfall: 0,
    windSpeed: 28,
    alertTone: 'neutral',
    historyTrend: -0.4,
    historyRainfall: [0, 0, 0, 0],
    forecastProbability: 8,
    currentPrecipitation: 0,
    weatherCode: 0,
  });

  assert.equal(result.probability <= 35, true);
  assert.match(result.label.toLowerCase(), /low|unlikely/i);
});
