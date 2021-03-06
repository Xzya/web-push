var webPush = require('../index');
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var fse = require('fs-extra');
var temp = require('temp').track();
var colors = require('colors');
var childProcess = require('child_process');
var http = require('http');
var portfinder = require('portfinder');
var net = require('net');
var seleniumInit = require('./selenium-init');

if (!process.env.GCM_API_KEY) {
  console.log('You need to set the GCM_API_KEY env variable to run the tests with Chromium.'.bold.red);
} else {
  webPush.setGCMAPIKey(process.env.GCM_API_KEY);
}

if (!process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_PUBLIC_KEY) {
  console.log('You haven\'t set the VAPID env variables, I\'ll generate them for you.'.bold.yellow);

  var keys = webPush.generateVAPIDKeys();
  process.env.VAPID_PRIVATE_KEY = keys.privateKey.toString('base64');
  process.env.VAPID_PUBLIC_KEY = keys.publicKey.toString('base64');
}

process.env.PATH = process.env.PATH + ':test_tools/';

function createServer(pushPayload, vapid) {
  var server = http.createServer(function(req, res) {
    if (req.method === 'GET') {
      if (req.url === '/') {
        req.url = '/index.html';
      }

      if (!fs.existsSync('test' + req.url)) {
        res.writeHead(404);
        res.end(data);
        return;
      }

      var data = fs.readFileSync('test' + req.url);

      res.writeHead(200, {
        'Content-Length': data.length,
        'Content-Type': path.extname(req.url) === '.html' ? 'text/html' : 'application/javascript',
      });

      res.end(data);
    } else {
      var body = '';

      req.on('data', function(chunk) {
        body += chunk;
      })

      req.on('end', function() {
        var obj = JSON.parse(body);

        console.log('Push Application Server - Register: ' + obj.endpoint);

        console.log('Push Application Server - Send notification to ' + obj.endpoint);

        var promise;
        if (!pushPayload) {
          promise = webPush.sendNotification(obj.endpoint, {
            vapid: vapid,
          });
        } else {
          promise = webPush.sendNotification(obj.endpoint, {
            payload: pushPayload,
            userPublicKey: obj.key,
            userAuth: obj.auth,
            vapid: vapid,
          });
        }

        promise
        .then(function() {
          console.log('Push Application Server - Notification sent to ' + obj.endpoint);
        })
        .catch(function(error) {
          console.log('Push Application Server - Error in sending notification to ' + obj.endpoint);
          console.log(error);
        })
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept',
      });

      res.end('ok');
    }
  });

  portfinder.getPort(function(err, port) {
    if (err) {
      server.port = 50005;
    } else {
      server.port = port;
    }
    server.listen(server.port);
  });

  return new Promise(function(resolve, reject) {
    server.on('listening', function() {
      resolve(server);
    });
  });
}

function isPortOpen(port) {
  return new Promise(function(resolve, reject) {
    var socket = new net.Socket();

    socket.on('connect', function() {
      socket.end();
      resolve(true);
    });

    socket.on('error', function() {
      resolve(false);
    });

    socket.connect({
      port: port,
    });
  });
}

suite('selenium', function() {
  var webdriver = require('selenium-webdriver');
  var firefox = require('selenium-webdriver/firefox');
  var chrome = require('selenium-webdriver/chrome');

  this.timeout(180000);

  var firefoxStableBinaryPath, firefoxBetaBinaryPath, firefoxAuroraBinaryPath, firefoxNightlyBinaryPath, chromeBinaryPath;
  var server, driver;

  function runTest(params) {
    var firefoxBinaryPath;
    if (params.browser === 'firefox') {
      firefoxBinaryPath = firefoxStableBinaryPath;
    } else if (params.browser === 'firefox-beta') {
      params.browser = 'firefox';
      firefoxBinaryPath = firefoxBetaBinaryPath;
    } else if (params.browser === 'firefox-aurora') {
      params.browser = 'firefox';
      firefoxBinaryPath = firefoxAuroraBinaryPath;
      process.env.SELENIUM_MARIONETTE = true;
    }

    if (firefoxBinaryPath) {
      firefoxBinaryPath = path.resolve(firefoxBinaryPath);
    }
    if (chromeBinaryPath) {
      chromeBinaryPath = path.resolve(chromeBinaryPath);
    }

    process.env.SELENIUM_BROWSER = params.browser;

    return createServer(params.payload, params.vapid)
    .then(function(newServer) {
      server = newServer;

      var profile = new firefox.Profile();
      profile.setPreference('security.turn_off_all_security_so_that_viruses_can_take_over_this_computer', true);
      profile.setPreference('extensions.checkCompatibility.nightly', false);
      // Only allow installation of third-party addons from the user's profile dir (needed to block the third-party
      // installation prompt for the Ubuntu Modifications addon on Ubuntu).
      profile.setPreference('extensions.enabledScopes', 1);
      //profile.setPreference('dom.push.debug', true);
      //profile.setPreference('browser.dom.window.dump.enabled', true);

      var firefoxBinary = new firefox.Binary(firefoxBinaryPath);

      var firefoxOptions = new firefox.Options().setProfile(profile).setBinary(firefoxBinary);

      var chromeOptions = new chrome.Options()
        .setChromeBinaryPath(chromeBinaryPath)
        .addArguments('--no-sandbox')
        .addArguments('user-data-dir=' + temp.mkdirSync('marco'));

      var builder = new webdriver.Builder()
        .forBrowser('firefox')
        .setFirefoxOptions(firefoxOptions)
        .setChromeOptions(chromeOptions);
      if (params.browser !== "chrome") {
        builder.usingServer('http://localhost:4444/wd/hub');
      }
      driver = builder.build();

      driver.executeScript(function(port) {
        if (typeof netscape !== 'undefined') {
          netscape.security.PrivilegeManager.enablePrivilege('UniversalXPConnect');
          Components.utils.import('resource://gre/modules/Services.jsm');
          var uri = Services.io.newURI('http://127.0.0.1:' + port, null, null);
          var principal = Services.scriptSecurityManager.getNoAppCodebasePrincipal(uri);
          Services.perms.addFromPrincipal(principal, 'desktop-notification', Services.perms.ALLOW_ACTION);
        }
      }, server.port);

      driver.get('http://127.0.0.1:' + server.port);

      return driver.wait(webdriver.until.titleIs(params.payload ? params.payload : 'no payload'), 60000);
    });
  }

  suiteSetup(function() {
    this.timeout(0);

    var promises = [];

    if (process.platform === 'linux') {
      firefoxStableBinaryPath = 'test_tools/stable/firefox/firefox-bin';
    } else if (process.platform === 'darwin') {
      firefoxStableBinaryPath = 'test_tools/stable/Firefox.app/Contents/MacOS/firefox-bin';
    }

    promises.push(seleniumInit.downloadFirefoxRelease());

    /*if (process.platform === 'linux') {
      firefoxBetaBinaryPath = 'test_tools/beta/firefox/firefox-bin';
    } else if (process.platform === 'darwin') {
      firefoxBetaBinaryPath = 'test_tools/beta/Firefox.app/Contents/MacOS/firefox-bin';
    }

    promises.push(seleniumInit.downloadFirefoxBeta());*/

    /*if (process.platform === 'linux') {
      firefoxAuroraBinaryPath = 'test_tools/aurora/firefox/firefox-bin';
    } else if (process.platform === 'darwin') {
      firefoxAuroraBinaryPath = 'test_tools/aurora/Firefox.app/Contents/MacOS/firefox-bin';
    }

    promises.push(seleniumInit.downloadFirefoxAurora());*/

    if (process.platform === 'linux') {
      firefoxNightlyBinaryPath = 'test_tools/firefox/firefox-bin';
    } else if (process.platform === 'darwin') {
      firefoxNightlyBinaryPath = 'test_tools/FirefoxNightly.app/Contents/MacOS/firefox-bin';
    }

    //promises.push(seleniumInit.downloadFirefoxNightly());

    promises.push(seleniumInit.downloadSeleniumServer());

    if (process.env.GCM_API_KEY) {
      if (process.platform === 'linux') {
        chromeBinaryPath = 'test_tools/chrome-linux/chrome';
      } else if (process.platform === 'darwin') {
        chromeBinaryPath = 'test_tools/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
      }

      promises.push(seleniumInit.downloadChromiumNightly());

      promises.push(seleniumInit.downloadChromeDriver());
    }

    return Promise.all(promises)
    .then(function() {
      if (!fs.existsSync(firefoxStableBinaryPath)) {
        throw new Error('Firefox binary doesn\'t exist at ' + firefoxStableBinaryPath + '. Use your installed Firefox binary by setting the FIREFOX environment'.bold.red);
      }

      /*if (firefoxBetaBinaryPath && !fs.existsSync(firefoxBetaBinaryPath)) {
        throw new Error('Firefox binary doesn\'t exist at ' + firefoxBetaBinaryPath + '.'.bold.red);
      }*/

      try {
        console.log('Using Firefox: ' + firefoxStableBinaryPath);
        console.log('Version: ' + childProcess.execSync(firefoxStableBinaryPath + ' --version').toString().replace('\n', ''));
        //console.log('Beta Version: ' + childProcess.execSync(firefoxBetaBinaryPath + ' --version').toString().replace('\n', ''));
        //console.log('Aurora Version: ' + childProcess.execSync(firefoxAuroraBinaryPath + ' --version').toString().replace('\n', ''));
        //console.log('Nightly Version: ' + childProcess.execSync(firefoxNightlyBinaryPath + ' --version').toString().replace('\n', ''));
      } catch (e) {}

      if (process.env.GCM_API_KEY && !fs.existsSync(chromeBinaryPath)) {
        throw new Error('Chrome binary doesn\'t exist at ' + chromeBinaryPath + '. Use your installed Chrome binary by setting the CHROME environment'.bold.red);
      }

      try {
        console.log('Using Chromium: ' + chromeBinaryPath);
        console.log('Version: ' + childProcess.execSync(chromeBinaryPath + ' --version').toString().replace('\n', ''));
      } catch (e) {}

      if (!fs.existsSync('test_tools/selenium-server-standalone-2.53.0.jar')) {
        throw new Error('Selenium server doesn\'t exist.');
      }

      childProcess.exec('java -jar test_tools/selenium-server-standalone-2.53.0.jar');

      // Return a promise that resolved once the Selenium server is listening to the port 4444.
      return new Promise(function(resolve, reject) {
        var timerID = setInterval(function() {
          isPortOpen(4444)
          .then(function(isOpen) {
            if (isOpen) {
              clearInterval(timerID);
              resolve();
            }
          })
          .catch(function() {
            clearInterval(timerID);
            reject();
          });
        }, 1000);
      })
    });
  });

  teardown(function(done) {
    driver.quit()
    .thenCatch(function() {})
    .then(function() {
      server.close(function() {
        done();
      });
    });
  });

  var vapidParam = {
    audience: 'https://www.mozilla.org/',
    subject: 'mailto:web-push@mozilla.org',
    privateKey: new Buffer(process.env.VAPID_PRIVATE_KEY, 'base64'),
    publicKey: new Buffer(process.env.VAPID_PUBLIC_KEY, 'base64'),
  };

  test('send/receive notification without payload with Firefox Release', function() {
    return runTest({
      browser: 'firefox',
    });
  });

  /*test('send/receive notification without payload with Firefox Beta', function() {
    return runTest({
      browser: 'firefox-beta',
    });
  });*/

  if (process.env.GCM_API_KEY && process.env.TRAVIS_OS_NAME !== 'osx') {
    test('send/receive notification without payload with Chrome', function() {
      return runTest({
        browser: 'chrome',
      });
    });
  }

  test('send/receive notification with payload with Firefox Release', function() {
    return runTest({
      browser: 'firefox',
      payload: 'marco',
    });
  });

  /*test('send/receive notification with payload with Firefox Beta', function() {
    return runTest({
      browser: 'firefox-beta',
      payload: 'marco',
    });
  });*/

  if (process.env.GCM_API_KEY && process.env.TRAVIS_OS_NAME !== 'osx') {
    test('send/receive notification with payload with Chrome', function() {
      return runTest({
        browser: 'chrome',
        payload: 'marco',
      });
    });
  }

  test('send/receive notification with vapid with Firefox Release', function() {
    return runTest({
      browser: 'firefox',
      vapid: vapidParam,
    });
  });

  /*test('send/receive notification with vapid with Firefox Beta', function() {
    return runTest({
      browser: 'firefox-beta',
      vapid: vapidParam,
    });
  });*/

  if (process.env.GCM_API_KEY && process.env.TRAVIS_OS_NAME !== 'osx') {
    test('send/receive notification with vapid with Chrome', function() {
      return runTest({
        browser: 'chrome',
        vapid: vapidParam,
      });
    });
  }

  /*test('send/receive notification with payload & vapid with Firefox Beta', function() {
    return runTest({
      browser: 'firefox-beta',
      payload: 'marco',
      vapid: vapidParam,
    });
  });*/

  if (process.env.GCM_API_KEY && process.env.TRAVIS_OS_NAME !== 'osx') {
    test('send/receive notification with payload & vapid with Chrome', function() {
      return runTest({
        browser: 'chrome',
        payload: 'marco',
        vapid: vapidParam,
      });
    });
  }
});
