const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const db = require('./db');

// Setup environment overrides for testing
process.env.PORT = '8090'; // Run proxy on 8090 for testing
process.env.DURIAN_API_BASE = 'http://localhost:8091'; // Point proxy to mock server on 8091
process.env.DEFAULT_PID = '0257';
process.env.DEFAULT_SERIAL = '2';
process.env.DEFAULT_DURIAN_NAME = 'admin';

// Start the real proxy server (it will automatically bind to PORT 8090 and point to DURIAN_API_BASE on 8091)
console.log('🔄 Initializing proxy server under test environment...');
require('./server.js');

// Initialize Mock DurianRCS Server
const mockApp = express();
mockApp.use(express.json());

// Track state in the mock server
const mockState = {
  score: 150.00,
  numberToProvide: '+59173841704',
  smsCodeToProvide: '123456',
  smsCallCount: 0,
  releasedNumber: null,
  blacklistedNumber: null
};

// Mock 1. getUserInfo
mockApp.get('/getUserInfo', (req, res) => {
  const { name, ApiKey } = req.query;
  console.log('   [Mock DurianRCS] Received getUserInfo query:', req.query);
  
  if (ApiKey === 'wrong_key') {
    return res.json({ code: 802, msg: 'Username or ApiKey incorrect', data: null });
  }
  
  return res.json({
    code: 200,
    msg: 'Success',
    data: {
      username: name,
      score: mockState.score,
      create_date: '2018-05-09 11:18:35'
    }
  });
});

// Mock 2. getMobile
mockApp.get('/getMobile', (req, res) => {
  console.log('   [Mock DurianRCS] Received getMobile query:', req.query);
  const { ApiKey, cuy, pid, num, serial } = req.query;

  if (ApiKey === 'wrong_key') {
    return res.json({ code: 802, msg: 'Username or ApiKey incorrect', data: null });
  }

  if (mockState.score < 5.0) {
    return res.json({ code: 403, msg: 'Insufficient balance', data: null });
  }

  return res.json({
    code: 200,
    msg: 'Success',
    data: mockState.numberToProvide
  });
});

// Mock 3. getMsg
mockApp.get('/getMsg', (req, res) => {
  console.log('   [Mock DurianRCS] Received getMsg query:', req.query);
  mockState.smsCallCount += 1;

  if (mockState.smsCallCount === 1) {
    // First poll: return "not received yet"
    return res.json({
      code: 908,
      msg: 'No SMS received yet, try again',
      data: null
    });
  } else {
    // Second poll: return code in success structure
    return res.json({
      code: 200,
      msg: 'Success',
      data: mockState.smsCodeToProvide
    });
  }
});

// Mock 4. passMobile
mockApp.get('/passMobile', (req, res) => {
  console.log('   [Mock DurianRCS] Received passMobile query:', req.query);
  mockState.releasedNumber = req.query.pn;
  return res.json({
    code: 200,
    msg: 'Success',
    data: ''
  });
});

// Mock 5. addBlack
mockApp.get('/addBlack', (req, res) => {
  console.log('   [Mock DurianRCS] Received addBlack query:', req.query);
  mockState.blacklistedNumber = req.query.pn;
  return res.json({
    code: 200,
    msg: 'Success',
    data: 1
  });
});

// Start Mock Server on Port 8091
const mockServer = mockApp.listen(8091, () => {
  console.log('✅ Mock DurianRCS Server is listening on http://localhost:8091');
  runTests();
});

// Test Suite
async function runTests() {
  console.log('\n🚀 Starting Test Suite...\n');
  const baseProxyUrl = 'http://localhost:8090/stubs/handler_api.php';
  let testPassed = true;

  try {
    // Test 1: getBalance (Success)
    console.log('🧪 Test 1: getBalance - Success');
    let res = await axios.get(baseProxyUrl, {
      params: { action: 'getBalance', api_key: 'valid_key' }
    });
    console.log('   Expected: ACCESS_BALANCE:150.00');
    console.log('   Got:     ', res.data);
    if (res.data === 'ACCESS_BALANCE:150.00') {
      console.log('   🟢 PASSED\n');
    } else {
      console.log('   🔴 FAILED\n');
      testPassed = false;
    }

    // Test 2: getBalance (Bad Key)
    console.log('🧪 Test 2: getBalance - Bad Key');
    res = await axios.get(baseProxyUrl, {
      params: { action: 'getBalance', api_key: 'wrong_key' }
    });
    console.log('   Expected: BAD_KEY');
    console.log('   Got:     ', res.data);
    if (res.data === 'BAD_KEY') {
      console.log('   🟢 PASSED\n');
    } else {
      console.log('   🔴 FAILED\n');
      testPassed = false;
    }

    // Test 3: getNumber (Bangladesh country=73, service=tg)
    console.log('🧪 Test 3: getNumber - Bangladesh country 73');
    res = await axios.get(baseProxyUrl, {
      params: { action: 'getNumber', api_key: 'valid_key', country: '73', service: 'tg' }
    });
    console.log('   Expected format: ACCESS_NUMBER:<activationId>:<phone>');
    console.log('   Got:     ', res.data);
    
    const numberParts = res.data.split(':');
    let activationId = '';
    let phoneNumber = '';
    
    if (numberParts[0] === 'ACCESS_NUMBER' && numberParts[1] && numberParts[2] === '59173841704') {
      activationId = numberParts[1];
      phoneNumber = numberParts[2];
      console.log(`   🟢 PASSED (Generated Activation ID: ${activationId})\n`);
    } else {
      console.log('   🔴 FAILED\n');
      testPassed = false;
    }

    // Test 4: getStatus (First Poll - Waiting)
    console.log('🧪 Test 4: getStatus - First Poll (Wait)');
    res = await axios.get(baseProxyUrl, {
      params: { action: 'getStatus', api_key: 'valid_key', id: activationId }
    });
    console.log('   Expected: STATUS_WAIT_CODE');
    console.log('   Got:     ', res.data);
    if (res.data === 'STATUS_WAIT_CODE') {
      console.log('   🟢 PASSED\n');
    } else {
      console.log('   🔴 FAILED\n');
      testPassed = false;
    }

    // Test 5: getStatus (Second Poll - Success)
    console.log('🧪 Test 5: getStatus - Second Poll (Success & Cache)');
    res = await axios.get(baseProxyUrl, {
      params: { action: 'getStatus', api_key: 'valid_key', id: activationId }
    });
    console.log('   Expected: STATUS_OK:123456');
    console.log('   Got:     ', res.data);
    if (res.data === 'STATUS_OK:123456') {
      console.log('   🟢 PASSED\n');
    } else {
      console.log('   🔴 FAILED\n');
      testPassed = false;
    }

    // Test 6: getStatus (Third Poll - Should hit cache directly)
    console.log('🧪 Test 6: getStatus - Third Poll (Cache Check)');
    mockState.smsCodeToProvide = '999999'; // Modify mock code to check if proxy uses cached one
    res = await axios.get(baseProxyUrl, {
      params: { action: 'getStatus', api_key: 'valid_key', id: activationId }
    });
    console.log('   Expected cached code: STATUS_OK:123456');
    console.log('   Got:                 ', res.data);
    if (res.data === 'STATUS_OK:123456') {
      console.log('   🟢 PASSED\n');
    } else {
      console.log('   🔴 FAILED\n');
      testPassed = false;
    }

    // Test 7: setStatus (Complete - status=6)
    console.log('🧪 Test 7: setStatus - Complete (status=6)');
    res = await axios.get(baseProxyUrl, {
      params: { action: 'setStatus', api_key: 'valid_key', id: activationId, status: '6' }
    });
    console.log('   Expected: ACCESS_ACTIVATION');
    console.log('   Got:     ', res.data);
    if (res.data === 'ACCESS_ACTIVATION' && mockState.releasedNumber === '+59173841704') {
      console.log('   🟢 PASSED\n');
    } else {
      console.log('   🔴 FAILED\n');
      testPassed = false;
    }

    // Test 8: setStatus (Cancel & Blacklist - status=8)
    console.log('🧪 Test 8: setStatus - Cancel/Blacklist (status=8)');
    // Get another number first
    res = await axios.get(baseProxyUrl, {
      params: { action: 'getNumber', api_key: 'valid_key', country: '73', service: 'wa' }
    });
    const nextActivationId = res.data.split(':')[1];
    
    res = await axios.get(baseProxyUrl, {
      params: { action: 'setStatus', api_key: 'valid_key', id: nextActivationId, status: '8' }
    });
    console.log('   Expected: ACCESS_CANCEL');
    console.log('   Got:     ', res.data);
    if (res.data === 'ACCESS_CANCEL' && mockState.blacklistedNumber === '+59173841704') {
      console.log('   🟢 PASSED\n');
    } else {
      console.log('   🔴 FAILED\n');
      testPassed = false;
    }

    // Test 9: getCountries
    console.log('🧪 Test 9: getCountries fallback endpoint');
    res = await axios.get(baseProxyUrl, {
      params: { action: 'getCountries' }
    });
    console.log('   Expected: JSON mapping object containing BD/US mapping');
    console.log('   Got JSON keys count:', Object.keys(res.data).length);
    if (res.data['73'] && res.data['73'].eng === 'BD') {
      console.log('   🟢 PASSED\n');
    } else {
      console.log('   🔴 FAILED\n');
      testPassed = false;
    }

    // Test 10: Stateless Fallback Test (Simulate Server Restart / DB Wipe)
    console.log('🧪 Test 10: Stateless Fallback Parsing');
    // Wipe local DB state
    db.data.activations = {};
    if (fs.existsSync(path.join(__dirname, 'database.json'))) {
      fs.unlinkSync(path.join(__dirname, 'database.json'));
    }
    
    // Reset mock server call count
    mockState.smsCallCount = 1; // It will return success on the next call
    mockState.smsCodeToProvide = '888888';
    
    // The stateless ID consists of: phone (59173841704) + pid (0257) + serial (2) = '5917384170402572'
    const statelessId = '5917384170402572';
    
    res = await axios.get(baseProxyUrl, {
      params: { action: 'getStatus', api_key: 'valid_key', id: statelessId }
    });
    
    console.log('   Expected stateless parsed code: STATUS_OK:888888');
    console.log('   Got:                           ', res.data);
    
    if (res.data === 'STATUS_OK:888888') {
      console.log('   🟢 PASSED\n');
    } else {
      console.log('   🔴 FAILED\n');
      testPassed = false;
    }

    // Final Report
    console.log('======================================');
    if (testPassed) {
      console.log('🎉 ALL INTEGRATION TESTS PASSED!');
    } else {
      console.log('❌ SOME TESTS FAILED, CHECK LOGS!');
    }
    console.log('======================================');

  } catch (error) {
    console.error('❌ Test execution failed with error:', error.message);
  } finally {
    // Clean up databases and close mock server
    console.log('🧹 Cleaning up database.json and closing servers...');
    try {
      if (fs.existsSync(path.join(__dirname, 'database.json'))) {
        fs.unlinkSync(path.join(__dirname, 'database.json'));
      }
      if (fs.existsSync(path.join(__dirname, 'database.json.tmp'))) {
        fs.unlinkSync(path.join(__dirname, 'database.json.tmp'));
      }
    } catch (e) {
      console.error('Database cleanup error:', e.message);
    }
    mockServer.close();
    process.exit(testPassed ? 0 : 1);
  }
}
