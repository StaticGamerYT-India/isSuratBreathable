const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateRainProbability, calculateAirQualityIndices } = require('../server');

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

test('calculateAirQualityIndices keeps US AQI and Indian NAQI distinct', () => {
  const result = calculateAirQualityIndices({
    PM2_5: '10',
    PM10: '60',
    So2: '50',
    CO: '1145',
    NOx: '80',
    Ambient_Temperature: '28',
    Relative_Humidity: '70',
  });

  assert.notEqual(result.usAqi.value, result.indiaNaqi.value);
  assert.equal(result.usAqi.subIndices.pm25 > 0, true);
  assert.equal(result.indiaNaqi.subIndices.pm10 > 0, true);
  assert.equal(result.usAqi.subIndices.co > 0, true);
  assert.equal(result.indiaNaqi.subIndices.co > 0, true);
  assert.match(result.usAqi.unavailablePollutants.join(' '), /NO2.*NOx/i);
  assert.deepEqual(result.excludedMeasurements, ['temperature', 'humidity', 'pressure', 'wind', 'rainfall', 'solar radiation']);
});
