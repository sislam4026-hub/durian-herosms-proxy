require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Load configurations from .env
const PORT = process.env.PORT || 8080;
const DEFAULT_NAME = process.env.DEFAULT_DURIAN_NAME || 'admin';
const DEFAULT_PID = process.env.DEFAULT_PID || '0257';
const DEFAULT_SERIAL = process.env.DEFAULT_SERIAL || '2';
const DEFAULT_VIP = process.env.DEFAULT_VIP === 'null' ? null : process.env.DEFAULT_VIP;
const DURIAN_API_BASE = process.env.DURIAN_API_BASE || 'https://api.durianrcs.com/out/ext_api';

// Load countries mapping
let countriesMap = {};
try {
  const countriesContent = fs.readFileSync(path.join(__dirname, 'countries.json'), 'utf8');
  countriesMap = JSON.parse(countriesContent);
} catch (error) {
  console.error('Failed to load countries.json:', error.message);
}

// Utility to normalize country code
function getCountryCode(countryInput) {
  if (!countryInput) return 'bd'; // Default to Bangladesh if empty
  
  const inputStr = String(countryInput).trim().toLowerCase();
  
  // If it's a numeric ID in countries.json, map it
  if (countriesMap[inputStr]) {
    return countriesMap[inputStr];
  }
  
  // If it's already a 2-letter alphabetical ISO code, use it directly
  if (/^[a-z]{2}$/.test(inputStr)) {
    return inputStr;
  }
  
  return 'bd'; // Default fallback
}

// Standard logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  if (req.method === 'POST') {
    console.log('Body:', req.body);
  }
  next();
});

// Main API Handler Endpoint compatible with HeroSMS / SMS-Activate protocol
app.all('/stubs/handler_api.php', async (req, res) => {
  // Merge query parameters and body parameters (supports both GET and POST)
  const params = { ...req.query, ...req.body };
  
  // Sanitize params: If multiple query params exist, Express creates an array. Flatten to first element string.
  for (const key in params) {
    if (Array.isArray(params[key])) {
      params[key] = params[key][0];
    }
  }

  const { action, api_key } = params;

  if (!action) {
    return res.status(400).send('BAD_ACTION');
  }

  if (!api_key && action !== 'getCountries') {
    return res.status(200).send('BAD_KEY');
  }

  try {
    switch (action) {
      case 'getBalance':
        return await handleGetBalance(res, api_key, params);
      
      case 'getNumber':
        return await handleGetNumber(res, api_key, params);
      
      case 'getStatus':
        return await handleGetStatus(res, api_key, params);
      
      case 'setStatus':
        return await handleSetStatus(res, api_key, params);
        
      case 'getCountries':
        return handleGetCountries(res);

      default:
        console.warn(`Unknown action requested: ${action}`);
        return res.status(200).send('BAD_ACTION');
    }
  } catch (error) {
    console.error(`Error handling action ${action}:`, error.message);
    if (error.response) {
      console.error('DurianRCS API Response Error Data:', error.response.data);
    }
    return res.status(200).send('ERROR');
  }
});

// 1. Get Balance
async function handleGetBalance(res, api_key, params) {
  const name = params.name || DEFAULT_NAME;
  
  const url = `${DURIAN_API_BASE}/getUserInfo`;
  const response = await axios.get(url, {
    params: {
      name: name,
      ApiKey: api_key
    }
  });

  const data = response.data;
  console.log('DurianRCS getUserInfo response:', data);

  if (data.code === 200 && data.data) {
    const score = data.data.score || 0;
    return res.send(`ACCESS_BALANCE:${score.toFixed(2)}`);
  } else if (data.code === 802 || data.code === 803) {
    return res.send('BAD_KEY');
  } else if (data.code === 800) {
    return res.send('BANNED');
  } else {
    return res.send(`ERROR:${data.msg || 'Unknown error'}`);
  }
}

// 2. Get Number
async function handleGetNumber(res, api_key, params) {
  const name = params.name || DEFAULT_NAME;
  const rawCountry = params.country;
  const cuy = getCountryCode(rawCountry);
  
  // Custom Project ID or Default
  const pid = params.pid || DEFAULT_PID;
  
  // Custom serial or Default (serial 2 is single number)
  const serial = params.serial || DEFAULT_SERIAL;
  
  // Custom vip or Default
  const vip = params.vip !== undefined ? params.vip : DEFAULT_VIP;

  console.log(`Requesting number: name=${name}, cuy=${cuy}, pid=${pid}, serial=${serial}, vip=${vip}`);

  const url = `${DURIAN_API_BASE}/getMobile`;
  const response = await axios.get(url, {
    params: {
      name: name,
      ApiKey: api_key,
      cuy: cuy,
      pid: pid,
      num: 1,
      noblack: 1,
      serial: serial,
      secret_key: 'null',
      vip: vip === null ? 'null' : vip
    }
  });

  const data = response.data;
  console.log('DurianRCS getMobile response:', data);

  if (data.code === 200 && data.data) {
    let rawPhone = '';
    if (Array.isArray(data.data)) {
      rawPhone = data.data[0];
    } else {
      rawPhone = data.data;
    }

    if (!rawPhone) {
      return res.send('NO_NUMBERS');
    }

    // Keep phone number with + for DurianRCS API
    const phoneWithPlus = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
    // Strip + for HeroSMS standard output
    const phoneDigits = phoneWithPlus.substring(1);

    // Generate stateless deterministic activation ID: phoneDigits + pid (4-padded) + serial (1-digit)
    const pidPadded = String(pid).padStart(4, '0');
    const serialDigit = String(serial).substring(0, 1);
    const activationId = `${phoneDigits}${pidPadded}${serialDigit}`;

    // Save activation record persistently
    db.save(activationId, {
      phone: phoneWithPlus,
      pid: pid,
      serial: serial,
      cuy: cuy,
      apiKey: api_key,
      name: name,
      status: 'active',
      smsCode: null,
      created: Date.now()
    });

    console.log(`Saved activation ${activationId} for phone ${phoneWithPlus}`);
    return res.send(`ACCESS_NUMBER:${activationId}:${phoneDigits}`);
  } else if (data.code === 403) {
    return res.send('NO_BALANCE');
  } else if (data.code === 802 || data.code === 803) {
    return res.send('BAD_KEY');
  } else if (data.code === 906 || data.code === 409 || data.code === 200408) {
    // 906: List empty, 409: High frequency, 200408: Upper limit reached
    return res.send('NO_NUMBERS');
  } else {
    return res.send(`NO_NUMBERS`); // Return standard no numbers for robustness
  }
}

// 3. Get Status / Get Verification Code
async function handleGetStatus(res, api_key, params) {
  const { id } = params;
  if (!id) {
    return res.send('BAD_ACTIVATION');
  }

  let activation = db.get(id);
  
  // Stateless fallback if record not found in ephemeral database (e.g. after server restart)
  if (!activation) {
    const idStr = String(id).trim();
    if (idStr.length >= 6) {
      const parsedSerial = idStr.slice(-1);
      const parsedPid = idStr.slice(-5, -1);
      const parsedPhoneDigits = idStr.slice(0, -5);
      const parsedPhone = '+' + parsedPhoneDigits;
      
      console.log(`[Stateless Fallback] Parsing activation ID ${idStr}: phone=${parsedPhone}, pid=${parsedPid}, serial=${parsedSerial}`);
      
      activation = {
        phone: parsedPhone,
        pid: parsedPid,
        serial: parsedSerial,
        apiKey: api_key,
        name: params.name || DEFAULT_NAME,
        status: 'active',
        smsCode: null
      };
    }
  }

  if (!activation) {
    return res.send('BAD_ACTIVATION');
  }

  // If already completed and has SMS code cached
  if (activation.status === 'completed' && activation.smsCode) {
    return res.send(`STATUS_OK:${activation.smsCode}`);
  }

  // If explicitly canceled
  if (activation.status === 'canceled') {
    return res.send('STATUS_CANCEL');
  }

  // Poll DurianRCS getMsg for the activation
  const url = `${DURIAN_API_BASE}/getMsg`;
  const response = await axios.get(url, {
    params: {
      name: activation.name,
      ApiKey: activation.apiKey,
      pn: activation.phone,
      pid: activation.pid,
      serial: activation.serial
    }
  });

  const data = response.data;
  console.log(`DurianRCS getMsg for activation ${id}:`, data);

  if (data.code === 200 && data.data) {
    // Extract verification code (digits only)
    const codeMatch = String(data.data).match(/\b\d{4,8}\b/);
    const smsCode = codeMatch ? codeMatch[0] : String(data.data).trim();

    // Cache SMS code and complete activation
    db.save(id, {
      status: 'completed',
      smsCode: smsCode
    });

    return res.send(`STATUS_OK:${smsCode}`);
  } else if (data.code === 407 && data.data) {
    // 407: "Access to all SMS..." e.g. "项目名称:123456;项目名称:123456;"
    const codeMatch = String(data.data).match(/\b\d{4,8}\b/);
    const smsCode = codeMatch ? codeMatch[0] : String(data.data).trim();

    db.save(id, {
      status: 'completed',
      smsCode: smsCode
    });

    return res.send(`STATUS_OK:${smsCode}`);
  } else if (data.code === 908) {
    // 908: Temporary no SMS code, waiting
    return res.send('STATUS_WAIT_CODE');
  } else if (data.code === 405) {
    // 405: Failed, check list or contact admin. Let the client keep polling.
    return res.send('STATUS_WAIT_CODE');
  } else {
    // Fallback to wait code to let clients continue polling until their timeouts
    return res.send('STATUS_WAIT_CODE');
  }
}

// 4. Set Status (Complete, Cancel, etc.)
async function handleSetStatus(res, api_key, params) {
  const { id, status } = params;
  if (!id || !status) {
    return res.send('BAD_ACTIVATION');
  }

  let activation = db.get(id);
  
  // Stateless fallback if record not found in ephemeral database (e.g. after server restart)
  if (!activation) {
    const idStr = String(id).trim();
    if (idStr.length >= 6) {
      const parsedSerial = idStr.slice(-1);
      const parsedPid = idStr.slice(-5, -1);
      const parsedPhoneDigits = idStr.slice(0, -5);
      const parsedPhone = '+' + parsedPhoneDigits;
      
      console.log(`[Stateless Fallback] Parsing activation ID ${idStr} for setStatus: phone=${parsedPhone}, pid=${parsedPid}, serial=${parsedSerial}`);
      
      activation = {
        phone: parsedPhone,
        pid: parsedPid,
        serial: parsedSerial,
        apiKey: api_key,
        name: params.name || DEFAULT_NAME,
        status: 'active',
        smsCode: null
      };
    }
  }

  if (!activation) {
    return res.send('BAD_ACTIVATION');
  }

  const statusNum = parseInt(status, 10);
  console.log(`SetStatus for activation ${id}: status=${statusNum}`);

  if (statusNum === 1 || statusNum === 3) {
    // 1: Ready, 3: Retry waiting. Just return success.
    return res.send('ACCESS_READY');
  } 
  
  if (statusNum === 6) {
    // 6: Complete/Confirm SMS received
    db.save(id, { status: 'completed' });
    
    // Release the phone number in DurianRCS
    try {
      const url = `${DURIAN_API_BASE}/passMobile`;
      await axios.get(url, {
        params: {
          name: activation.name,
          ApiKey: activation.apiKey,
          pn: activation.phone,
          pid: activation.pid,
          serial: activation.serial
        }
      });
    } catch (e) {
      console.error(`Failed to call passMobile for activation ${id} completion:`, e.message);
    }
    
    return res.send('ACCESS_ACTIVATION');
  } 
  
  if (statusNum === 8) {
    // 8: Cancel/Release number without SMS
    db.save(id, { status: 'canceled' });

    // Release the phone number in DurianRCS
    try {
      const url = `${DURIAN_API_BASE}/passMobile`;
      await axios.get(url, {
        params: {
          name: activation.name,
          ApiKey: activation.apiKey,
          pn: activation.phone,
          pid: activation.pid,
          serial: activation.serial
        }
      });
    } catch (e) {
      console.error(`Failed to call passMobile for activation ${id} cancellation:`, e.message);
    }

    // Optionally also blacklist the number to avoid getting it again
    try {
      const url = `${DURIAN_API_BASE}/addBlack`;
      await axios.get(url, {
        params: {
          name: activation.name,
          ApiKey: activation.apiKey,
          pn: activation.phone,
          pid: activation.pid
        }
      });
      console.log(`Added number ${activation.phone} to blacklist in DurianRCS`);
    } catch (e) {
      console.error(`Failed to blacklist number ${activation.phone} during cancellation:`, e.message);
    }

    return res.send('ACCESS_CANCEL');
  }

  return res.send('BAD_STATUS');
}

// 5. Get Countries (Fallback for initialization/checks)
function handleGetCountries(res) {
  const result = {};
  
  // Format standard getCountries JSON output
  Object.keys(countriesMap).forEach((id) => {
    const isoCode = countriesMap[id];
    result[id] = {
      id: parseInt(id, 10),
      eng: isoCode.toUpperCase(),
      visible: 1,
      retry: 1,
      rent: 1,
      multiService: 1
    };
  });

  return res.json(result);
}

// Simple healthcheck and admin UI endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'DurianRCS to HeroSMS API Proxy',
    uptime: process.uptime(),
    activationsCount: db.list().length,
    config: {
      defaultPid: DEFAULT_PID,
      defaultSerial: DEFAULT_SERIAL,
      defaultVip: DEFAULT_VIP
    }
  });
});

// Admin endpoint to view active and historic database entries
app.get('/admin/activations', (req, res) => {
  res.json(db.list().sort((a, b) => b.updatedAt - a.updatedAt));
});

// Start proxy server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`🚀 DurianRCS to HeroSMS API Proxy Server is online!`);
  console.log(`📍 Endpoint compatible: http://localhost:${PORT}/stubs/handler_api.php`);
  console.log(`📍 Admin console: http://localhost:${PORT}/admin/activations`);
  console.log(`⚙️  Default Project ID (pid): ${DEFAULT_PID}`);
  console.log(`⚙️  Default Serial Parameter: ${DEFAULT_SERIAL}`);
  console.log(`⚙️  Default Username (name): ${DEFAULT_NAME}`);
  console.log(`⚙️  Default VIP Parameter: ${DEFAULT_VIP || 'null'}`);
  console.log(`==================================================`);
});
