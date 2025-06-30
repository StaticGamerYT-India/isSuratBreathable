const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
const port = 3000;

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
      "headers": {
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
        "cookie": cookie,
        "Referer": "https://www.suratmunicipal.gov.in/Departments/AirQualityResults",
        "Referrer-Policy": "strict-origin-when-cross-origin"
      },
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
      "headers": {
        "accept": "*/*",
        "accept-language": "en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "priority": "u=1, i",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-requested-with": "XMLHttpRequest",
        "cookie": cookie,
        "Referer": "https://www.suratmunicipal.gov.in/Departments/AirQualityResults",
        "Referrer-Policy": "strict-origin-when-cross-origin"
      },
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

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});

// This part is for local development, Vercel will handle the server.
if (process.env.NODE_ENV !== 'production') {
  app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
  });
}

module.exports = app;
