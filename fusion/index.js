/*--------------------
// FusionDsp plugin for volumio 3. By balbuze August 2025
contribution : Paolo Sabatino
Multi Dsp features
Based on CamillaDsp
----------------------
*/

'use strict';

const io = require('socket.io-client');
const fs = require('fs-extra');
const exec = require('child_process').exec;
const execSync = require('child_process').execSync;
const libQ = require('kew');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');
const { CamillaDsp } = require('./camilladsp-js');

//---global Eq Variables
const tnbreq = 50// Nbre total of Eq
const filterfolder = "/data/INTERNAL/FusionDsp/filters/";
const filtersource = "/data/INTERNAL/FusionDsp/filter-sources/";
const tccurvepath = "/data/INTERNAL/FusionDsp/target-curves/";
const hrtffilterpath = "/data/plugins/audio_interface/fusiondsp/hrtf-filters/";
const toolspath = "INTERNAL/FusionDsp/tools/";
const presetFolder = "/data/INTERNAL/FusionDsp/presets/";
const eq15range = [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000]//freq for graphic eq
const baseQ = 1.4
//const coefQ = [baseQ + 0.5, baseQ + 0.5, baseQ + 0.5, baseQ + 0.5, baseQ + 0.5, baseQ + 0.40, baseQ + 0.40, baseQ + 0.28, baseQ + 0.28, baseQ + 0.38, baseQ + 0.38, baseQ + 0.38, baseQ + 0.49, baseQ + 0.49, baseQ + 0.49]//Q for graphic EQ
const coefQ = [1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85, 1.85]
const eq3range = [185, 1300, 5500]// freq for Eq3
const coefQ3 = [0.82, 0.4, 0.82]//Q for graphic EQ3
const eq3type = ["Lowshelf2", "Peaking", "Highshelf2"] //Filter type for EQ3
const sv = 34300 // sound velocity cm/s
const logPrefix = "FusionDsp - "

const fileStreamParams = "/tmp/fusiondsp_stream_params.log";

// Define the Parameq class
module.exports = FusionDsp;

function FusionDsp(context) {
  const self = this;
  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.commandRouter.logger;
  this.context = context;
  this.commandRouter = this.context.coreCommand;
  this.logger = this.context.logger;
  this.configManager = this.context.configManager;
};

FusionDsp.prototype.onVolumioStart = function () {
  const self = this;
  let configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  this.config = new (require('v-conf'))();
  this.config.loadFile(configFile);
  return libQ.resolve();
};

FusionDsp.prototype.onStart = function () {
  const self = this;
  let defer = libQ.defer();
  self.commandRouter.loadI18nStrings();
  self.commandRouter.executeOnPlugin('audio_interface', 'alsa_controller', 'updateALSAConfigFile');
  setTimeout(function () {
    self.loadalsastuff();
    self.camillaProcess = new CamillaDsp(self.logger);
    self.camillaProcess.start();
    self.hwinfo();
    self.purecamillagui();
    self.getIP();
    self.socket = io.connect('http://localhost:3000');
    self.reportFusionEnabled();
    self.checksamplerate();
    //self.createCamillaWebsocket();
  }, 2000);

  // if mixer set to none, do not show loudness settings
  var mixt = this.getAdditionalConf('audio_interface', 'alsa_controller', 'mixer_type');

  self.logger.info(logPrefix + ' mixtype--------------------- ' + mixt)
  if (mixt == 'None') {
    self.config.set('loudness', false)
    self.config.set('showloudness', false)

  } else {
    self.config.set('showloudness', true)
  }

  setTimeout(function () {
    self.createCamilladspfile()
    if (self.config.get('loudness')) {
      self.sendvolumelevel()
    }
  }, 2000);

  defer.resolve();
  return defer.promise;
};

FusionDsp.prototype.onStop = function () {
  const self = this;
  let defer = libQ.defer();
  self.socket.off()
  self.logger.info(logPrefix + ' Stopping FusionDsp service');
  self.camillaProcess.stop();
  self.camillaProcess = null;

  exec("/usr/bin/sudo /bin/systemctl stop fusiondsp.service", {
    uid: 1000,
    gid: 1000
  }, function (error, stdout, stderr) {
    if (error) {
      self.logger.info(logPrefix + ' Error in killing FusionDsp')
    } else {
      self.reportFusionDisabled();
    }
  });
  defer.resolve();
  return defer.promise;
};

FusionDsp.prototype.onRestart = function () {
  const self = this;
};

FusionDsp.prototype.onInstall = function () {
  const self = this;
};

FusionDsp.prototype.onUninstall = function () {
  const self = this;
};

FusionDsp.prototype.getI18nFile = function (langCode) {
  const i18nFiles = fs.readdirSync(path.join(__dirname, 'i18n'));
  const langFile = 'strings_' + langCode + '.json';

  // check for i18n file fitting the system language
  if (i18nFiles.some(function (i18nFile) { return i18nFile === langFile; })) {
    return path.join(__dirname, 'i18n', langFile);
  }
  // return default i18n file
  return path.join(__dirname, 'i18n', 'strings_en.json');
}

FusionDsp.prototype.loadalsastuff = function () {
  const self = this;
  var defer = libQ.defer();
  try {
    execSync(`/bin/touch ${fileStreamParams} && /bin/chmod 666 ${fileStreamParams} && /bin/touch /tmp/camilladsp.log && /bin/chmod 666 /tmp/camilladsp.log && /usr/bin/mkfifo -m 646 /tmp/fusiondspfifo`, {
      uid: 1000,
      gid: 1000
    })
  } catch (err) {
    self.logger.error(logPrefix + ' ----failed to create fusiondspfifo :' + err);
    defer.reject(err);
  }
};

FusionDsp.prototype.createCamillaWebsocket = function () {
  const self = this;
  var defer = libQ.defer();

  self.connection = null;
  function MyWebSocket() {
    self.connect = function () {
      const url = 'ws://localhost:9876';
      self.connection = new WebSocket(url);

      self.connection.onopen = function () {
        console.log('WebSocket connection established');
      };

      self.connection.onmessage = function (event) {
        console.log('WebSocket message received:', event.data);
      };

      self.connection.onerror = function (error) {
        self.logger.error(logPrefix + 'WebSocket error:', error);
      };

      self.connection.onclose = function () {
        console.log('WebSocket connection closed');
      };
    };
  }
  self.sendData = function (data) {
    if (self.connection && self.connection.readyState === WebSocket.OPEN) {
      self.connection.send(data);
    } else {
      self.logger.error(logPrefix + 'WebSocket is not connected');
    }
  };

  self.disconnect = function () {
    if (self.connection) {
      self.connection.close();
      self.connection = null;
    }
  };

  const myWebSocket = new MyWebSocket();



};

//------------------Hw detection--------------------

//here we detect hw info
FusionDsp.prototype.hwinfo = function () {
  const self = this;
  let defer = libQ.defer();

  let output_device = this.getAdditionalConf('audio_interface', 'alsa_controller', 'outputdevice');
  let nchannels;
  let formats;
  let hwinfo;
  let samplerates;
  try {
    execSync('/data/plugins/audio_interface/fusiondsp/hw_params ' + 'volumioHw' + ' >/data/configuration/audio_interface/fusiondsp/hwinfo.json ', {
      uid: 1000,
      gid: 1000
    });
    hwinfo = fs.readFileSync('/data/configuration/audio_interface/fusiondsp/hwinfo.json');
    try {
      const hwinfoJSON = JSON.parse(hwinfo);
      samplerates = hwinfoJSON.samplerates.value;
      self.logger.info(logPrefix + ' AAAAAAAAAAAAAA-> ' + samplerates + ' <-AAAAAAAAAAAAA');
      self.config.set('probesmplerate', samplerates);
    } catch (err) {
      self.logger.error(logPrefix + ' Error reading hwinfo.json, detection failed :', err);
    }
    defer.resolve();
  } catch (err) {
    self.logger.error(logPrefix + ' ----Hw detection failed :' + err);
    defer.reject(err);
  }
};

// Configuration methods------------------------------------------------------------------------

FusionDsp.prototype.getUIConfig = function (address) {
  const self = this;
  let defer = libQ.defer();
  const langCode = this.commandRouter.sharedVars.get('language_code');
  /*
    let lang_code = this.commandRouter.sharedVars.get('language_code');
    self.commandRouter.i18nJson(__dirname + '/i18n/strings_' + lang_code + '.json',
      __dirname + '/i18n/strings_en.json',
      __dirname + '/UIConfig.json')
  
  
  let langCode = lang_code || 'en';
  const langFile = path.join(__dirname, 'i18n', `strings_${langCode}.json`);
  const fallbackFile = path.join(__dirname, 'i18n', 'strings_en.json');
  const uiConfigFile = path.join(__dirname, 'UIConfig.json');
  
  // Ensure the language file exists; fallback to English if it doesn't
  if (!fs.existsSync(langFile)) {
      langCode = 'en';
  }
  
  self.commandRouter.i18nJson(
      path.join(__dirname, 'i18n', `strings_${langCode}.json`),
      fallbackFile,
      uiConfigFile
  )
  */
  self.commandRouter.i18nJson(path.join(__dirname, 'i18n', 'strings_' + langCode + '.json'),
    path.join(__dirname, 'i18n', 'strings_en.json'),
    path.join(__dirname, 'UIConfig.json'))


    .then(function (uiconf) {
      var value
      let ncontent = self.config.get('nbreq')
      var effect = self.config.get('effect')

      value = self.config.get('eqpresetsaved');

      //--------section 0-------------------
      //let dspoptions
      let selectedsp = self.config.get('selectedsp');
      switch (selectedsp) {

        case ("EQ3"):
          var dsplabel = self.commandRouter.getI18nString('EQ3_LABEL')
          break;
        case ("EQ15"):
          var dsplabel = self.commandRouter.getI18nString('EQ15_LABEL')
          break;
        case ("2XEQ15"):
          var dsplabel = self.commandRouter.getI18nString('2XEQ15_LABEL')
          break;
        case ("PEQ"):
          var dsplabel = self.commandRouter.getI18nString('PEQ_LABEL')
          break;
        case ("convfir"):
          var dsplabel = self.commandRouter.getI18nString('CONV_LABEL')
          break;
        case ("purecgui"):
          var dsplabel = "Pure CamillaDsp gui"
          break;
        default: "EQ15"
      }
      // No convolution if cpu is armv6l
      fs.access("/data/plugins/audio_interface/fusiondsp/cpuarmv6l", fs.F_OK, (err) => {
        if (err) {
          //  self.logger.info(logPrefix + ' << convolution filters available');
          var dspoptions = [{
            "value": "EQ3",
            "label": self.commandRouter.getI18nString('EQ3_LABEL')
          },
          {
            "value": "EQ15",
            "label": self.commandRouter.getI18nString('EQ15_LABEL')
          },
          {
            "value": "2XEQ15",
            "label": self.commandRouter.getI18nString('2XEQ15_LABEL')
          },
          {
            "value": "PEQ",
            "label": self.commandRouter.getI18nString('PEQ_LABEL')
          },
          {
            "value": "convfir",
            "label": self.commandRouter.getI18nString('CONV_LABEL')
          },
          {
            "value": "purecgui",
            "label": "Pure CamillaDsp Gui"
          }]
          self.configManager.setUIConfigParam(uiconf, 'sections[0].content[0].value.value', selectedsp);
          self.configManager.setUIConfigParam(uiconf, 'sections[0].content[0].value.label', dsplabel);

          for (let c in dspoptions) {
            self.configManager.pushUIConfigParam(uiconf, 'sections[0].content[0].options', {
              value: dspoptions[c].value,
              label: dspoptions[c].label
            }
            )
          };
        } else {
          self.logger.info(logPrefix + ' >>>>>>>>>>>>> armv6l')
          self.logger.info(logPrefix + ' Convolution not available for cpu armv6l !');
          var dspoptions = [{
            "value": "EQ3",
            "label": self.commandRouter.getI18nString('EQ3_LABEL')
          },
          {
            "value": "EQ15",
            "label": self.commandRouter.getI18nString('EQ15_LABEL')
          },
          {
            "value": "2XEQ15",
            "label": self.commandRouter.getI18nString('2XEQ15_LABEL')
          },
          {
            "value": "PEQ",
            "label": self.commandRouter.getI18nString('PEQ_LABEL')
          }]
          self.configManager.setUIConfigParam(uiconf, 'sections[0].content[0].value.value', selectedsp);
          self.configManager.setUIConfigParam(uiconf, 'sections[0].content[0].value.label', dsplabel);

          for (let c in dspoptions) {
            self.configManager.pushUIConfigParam(uiconf, 'sections[0].content[0].options', {
              value: dspoptions[c].value,
              label: dspoptions[c].label
            }
            )
          };
        }
      })
      //-------------section 1----------
      if (selectedsp == 'PEQ') {
        //----------------PEQ section----------------------

        uiconf.sections[1].content[0].hidden = true;
        uiconf.sections[1].content[1].hidden = true;
        uiconf.sections[1].content[2].hidden = true;
        uiconf.sections[1].content[3].hidden = true;
        uiconf.sections[1].content[4].hidden = true;
        uiconf.sections[7].hidden = true;
        uiconf.sections[9].hidden = true;

        let n = 1
        let eqval = self.config.get('mergedeq')
        let subtypex = eqval.toString().split('|')

        for (n; n <= ncontent; n++) {

          let typeinui = subtypex[((n - 1) * 4) + 1]
          let peqlabel
          // if (typeinui == undefined) {
          // typeinui = 'None'
          switch (typeinui) {
            case ("undefined"):
              peqlabel = "None"
              typeinui = 'None'
              break;
            case ("None"):
              peqlabel = "None"
              break;
            case ("Peaking"):
              peqlabel = "Peaking Hz,dB,Q"
              break;
            case ("Peaking2"):
              peqlabel = "Peaking Hz,dB,bandwidth Octave"
              break;
            case ("Lowshelf"):
              peqlabel = "Lowshelf Hz,dB,slope dB/Octave"
              break;
            case ("Lowshelf2"):
              peqlabel = "Lowshelf Hz,dB,Q"
              break;
            case ("Highshelf"):
              peqlabel = "Highshelf Hz,dB,slope dB/Octave"
              break;
            case ("Highshelf2"):
              peqlabel = "Highshelf Hz,dB,Q"
              break;
            case ("Highpass"):
              peqlabel = "Highpass Hz,Q"
              break;
            case ("Lowpass"):
              peqlabel = "Lowpass Hz,Q"
              break;
            case ("LowpassFO"):
              peqlabel = "LowpassFO Hz"
              break;
            case ("HighpassFO"):
              peqlabel = "HighpassFO Hz"
              break;
            case ("LowshelfFO"):
              peqlabel = "LowshelfFO Hz,dB"
              break;
            case ("HighshelfFO"):
              peqlabel = "HighshelfFO Hz,dB"
              break;
            case ("Notch"):
              peqlabel = "Notch Hz,Q"
              break;
            case ("Notch2"):
              peqlabel = "Notch Hz,bandwidth Octave"
              break;
            case ("LinkwitzTransform"):
              peqlabel = "LinkwitzTransform Fa Hz,Qa,FT Hz,Qt"
              break;
            case ("ButterworthHighpass"):
              peqlabel = "ButterworthHighpass Hz, order"
              break;
            case ("ButterworthLowpass"):
              peqlabel = "ButterworthLowpass Hz, order"
              break;
            default: "None"
          }

          let scopeinui = subtypex[((n - 1) * 4) + 2]
          if (scopeinui == undefined) {
            scopeinui = 'L+R'
          }

          let eqinui = subtypex[((n - 1) * 4) + 3]
          if (eqinui == undefined) {
            eqinui = '0,0,0'
          }

          let options = [{ "value": "None", "label": "None" },
          { "value": "Peaking", "label": "Peaking Hz,dB,Q" },
          { "value": "Peaking2", "label": "Peaking Hz,dB,bandwidth Octave" },
          { "value": "Lowshelf", "label": "Lowshelf Hz,dB,slope dB/Octave" },
          { "value": "Lowshelf2", "label": "Lowshelf Hz,dB,Q" },
          { "value": "Highshelf", "label": "Highshelf Hz,dB,slope dB/Octave" },
          { "value": "Highshelf2", "label": "Highshelf Hz,dB,Q" },
          { "value": "LowshelfFO", "label": "LowshelfFO Hz,dB" },
          { "value": "HighshelfFO", "label": "HighshelfFO Hz,dB" },
          { "value": "Notch", "label": "Notch Hz,Q" },
          { "value": "Notch2", "label": "Notch Hz,bandwidth Octave" },
          { "value": "Highpass", "label": "Highpass Hz,Q" },
          { "value": "Lowpass", "label": "Lowpass Hz,Q" },
          { "value": "HighpassFO", "label": "HighpassFO Hz" },
          { "value": "LowpassFO", "label": "LowpassFO Hz" },
          { "value": "LinkwitzTransform", "label": "Linkwitz Transform Fa Hz,Qa,FT Hz,Qt" },
          { "value": "ButterworthHighpass", "label": "ButterworthHighpass Hz, order" },
          { "value": "ButterworthLowpass", "label": "ButterworthLowpass Hz, order" },
          { "value": "Remove", "label": "Remove" }]

          uiconf.sections[1].content.push(

            {
              "id": "type" + n,
              "element": "select",
              "label": "Type Eq" + n,
              "doc": self.commandRouter.getI18nString("TYPEEQ_DOC"),
              "value": { "value": typeinui, "label": peqlabel },
              "options": options,
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            }
          )

          uiconf.sections[1].content.push(
            {
              "id": "scope" + n,
              "element": "select",
              "doc": self.commandRouter.getI18nString('EQSCOPE_DOC'),
              "label": self.commandRouter.getI18nString('EQSCOPE') + n,
              "value": { "value": scopeinui, "label": scopeinui },
              "options": [{ "value": "L+R", "label": "L+R" }, { "value": "L", "label": "L" }, { "value": "R", "label": "R" }],
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            },
            {
              "id": "eq" + n,
              "element": "input",
              "doc": self.commandRouter.getI18nString("EQ_DOC"),
              "label": "Eq " + n,
              "value": eqinui,
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            }
          );

          var eqn = 'eq' + n;
          uiconf.sections[1].saveButton.data.push(eqn);
          uiconf.sections[1].saveButton.data.push('type' + n);
          uiconf.sections[1].saveButton.data.push('scope' + n);
        }


        if (ncontent <= tnbreq) {
          uiconf.sections[1].content.push(
            {
              "id": "addeq",
              "element": "button",
              "label": self.commandRouter.getI18nString('ADD_EQ'),
              "doc": self.commandRouter.getI18nString('ADD_EQ_DESC'),
              "onClick": {
                "type": "plugin",
                "endpoint": "audio_interface/fusiondsp",
                "method": "addeq",
                "data": []
              },
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            }
          )
        }
        if (ncontent > 1) {
          uiconf.sections[1].content.push(
            {
              "id": "removeeq",
              "element": "button",
              "label": self.commandRouter.getI18nString("REMOVE_EQ"),
              "doc": self.commandRouter.getI18nString('REMOVE_EQ_DESC'),
              "onClick": {
                "type": "plugin",
                "endpoint": "audio_interface/fusiondsp",
                "method": "removeeq",
                "data": []
              },
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            },
            {
              "id": "removealleq",
              "element": "button",
              "label": self.commandRouter.getI18nString("REMOVEALL_EQ"),
              "doc": self.commandRouter.getI18nString('REMOVEALL_EQ_DESC'),
              "onClick": {
                "type": "plugin",
                "endpoint": "audio_interface/fusiondsp",
                "method": "removealleq",
                "data": []
              },
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            }
          )
        }

        //------end of PEQ section----------
      } else if ((selectedsp == 'EQ15') || (selectedsp == '2XEQ15')) {
        //------------EQ 15 section---------

        uiconf.sections[1].content[0].hidden = true;
        uiconf.sections[1].content[1].hidden = true;
        uiconf.sections[1].content[2].hidden = true;
        uiconf.sections[1].content[3].hidden = true;
        uiconf.sections[1].content[4].hidden = true;
        uiconf.sections[9].hidden = true;


        uiconf.sections[4].hidden = true;
        uiconf.sections[5].hidden = true;
        uiconf.sections[7].hidden = true;

        let listeq
        let eqtext
        if (selectedsp == 'EQ15') {
          listeq = ['geq15']
          eqtext = self.commandRouter.getI18nString('LANDRCHAN')

        } if (selectedsp == '2XEQ15') {
          listeq = ['geq15', 'x2geq15']
          eqtext = (self.commandRouter.getI18nString('LEFTCHAN') + ',' + self.commandRouter.getI18nString('RIGHTCHAN'))
        }

        for (var i in listeq) {
          let neq = eqtext.split(',')[i]

          let geq15 = self.config.get(listeq[i])
          uiconf.sections[1].content.push(
            {
              "id": listeq[i],
              "element": "equalizer",
              "label": neq,
              "description": "",
              "doc": self.commandRouter.getI18nString('DOCEQ'),
              "visibleIf": {
                "field": "showeq",
                "value": true
              },
              "config": {
                "orientation": "vertical",
                "bars": [
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[0],
                    "ticksLabels": [
                      eq15range[0]
                    ],
                    "tooltip": "show"
                  },
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[1],
                    "ticksLabels": [
                      eq15range[1]
                    ],
                    "tooltip": "show"
                  }, {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[2],
                    "ticksLabels": [
                      eq15range[2]
                    ],
                    "tooltip": "show"
                  }, {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[3],
                    "ticksLabels": [
                      eq15range[3]
                    ],
                    "tooltip": "show"
                  }, {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[4],
                    "ticksLabels": [
                      eq15range[4]
                    ],
                    "tooltip": "show"
                  }, {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[5],
                    "ticksLabels": [
                      eq15range[5]
                    ],
                    "tooltip": "show"
                  },
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[6],
                    "ticksLabels": [
                      eq15range[6]
                    ],
                    "tooltip": "show"
                  },
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[7],
                    "ticksLabels": [
                      eq15range[7]
                    ],
                    "tooltip": "show"
                  },
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[8],
                    "ticksLabels": [
                      eq15range[8]
                    ],
                    "tooltip": "show"
                  },
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[9],
                    "ticksLabels": [
                      eq15range[9]
                    ],
                    "tooltip": "show"
                  },
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[10],
                    "ticksLabels": [
                      eq15range[10]
                    ],
                    "tooltip": "show"
                  },
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[11],
                    "ticksLabels": [
                      eq15range[11]
                    ],
                    "tooltip": "show"
                  },
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[12],
                    "ticksLabels": [
                      eq15range[12]
                    ],
                    "tooltip": "show"
                  },
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[13],
                    "ticksLabels": [
                      eq15range[13]
                    ],
                    "tooltip": "show"
                  },
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq15.split(',')[14],
                    "ticksLabels": [
                      eq15range[14]
                    ],
                    "tooltip": "show"
                  }
                ]
              }
            }

          )
          uiconf.sections[1].saveButton.data.push(listeq[i]);
        }
        uiconf.sections[1].content.push(
          {
            "id": "reset",
            "element": "button",
            "label": self.commandRouter.getI18nString("RESETEQ"),
            "doc": self.commandRouter.getI18nString("RESETEQ_DOC"),
            "onClick": {
              "type": "plugin",
              "endpoint": "audio_interface/fusiondsp",
              "method": "reseteq",
              "data": [],

            },
            "visibleIf": {
              "field": "showeq",
              "value": true
            }
          }
        )
        //----End EQ15-------------
      } else if (selectedsp == 'EQ3') {
        //------------EQ 3 section---------

        uiconf.sections[1].content[0].hidden = true;
        uiconf.sections[1].content[1].hidden = true;
        uiconf.sections[1].content[2].hidden = true;
        uiconf.sections[1].content[3].hidden = true;
        uiconf.sections[1].content[4].hidden = true;
        // uiconf.sections[1].content[7].hidden = true;
        //   uiconf.sections[1].content[6].hidden = true;


        uiconf.sections[2].hidden = true;
        uiconf.sections[3].hidden = true;

        uiconf.sections[4].hidden = true;
        uiconf.sections[5].hidden = true;
        uiconf.sections[6].hidden = true;

        uiconf.sections[7].hidden = true;
        uiconf.sections[8].hidden = true;
        uiconf.sections[9].hidden = true;



        selectedsp == 'EQ3'
        var listeq3 = ['geq3']
        var neq = self.commandRouter.getI18nString('LANDRCHAN')//self.commandRouter.getI18nString('EQ3_LABEL')


        for (var i in listeq3) {
          //  let neq = eqtext.split(',')[i]

          let geq3 = self.config.get(listeq3[i])
          uiconf.sections[1].content.push(
            {
              "id": listeq3[i],
              "element": "equalizer",
              "label": neq,
              "description": "",
              "doc": self.commandRouter.getI18nString('DOCEQ'),
              "config": {
                "orientation": "vertical",
                "bars": [
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq3.split(',')[0],
                    "ticksLabels": [self.commandRouter.getI18nString('EQ3_LOW')
                    ],
                    "tooltip": "show"
                  },
                  {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq3.split(',')[1],
                    "ticksLabels": [self.commandRouter.getI18nString('EQ3_MID')
                    ],
                    "tooltip": "show"
                  }, {
                    "min": -10,
                    "max": 10,
                    "step": "0.5",
                    "value": geq3.split(',')[2],
                    "ticksLabels": [self.commandRouter.getI18nString('EQ3_HIGH')
                    ],
                    "tooltip": "show"
                  }
                ]
              }
            }

          )
          uiconf.sections[1].saveButton.data.push(listeq3[i]);
        }

        //----End EQ3-------------
        //----------------------convfir section-------------------

      } else if (selectedsp == 'convfir') {
        //self.logger.info(logPrefix + ' ---------convfir selected-------------')
        //uiconf.sections[2].hidden = true;
        //uiconf.sections[3].hidden = true;
        uiconf.sections[4].hidden = true;
        uiconf.sections[5].hidden = true;
        uiconf.sections[9].hidden = true;

        var value
        var valuestored
        let valuestoredl
        let valuestoredr

        valuestoredl = self.config.get('leftfilter');
        var valuestoredllabel = valuestoredl.replace("$samplerate$", "variable samplerate")
        self.configManager.setUIConfigParam(uiconf, 'sections[1].content[0].value.value', valuestoredl);
        self.configManager.setUIConfigParam(uiconf, 'sections[1].content[0].value.label', valuestoredllabel);

        value = self.config.get('attenuationl');
        self.configManager.setUIConfigParam(uiconf, 'sections[1].content[1].value.value', value);
        self.configManager.setUIConfigParam(uiconf, 'sections[1].content[1].value.label', value);

        valuestoredr = self.config.get('rightfilter');
        var valuestoredrlabel = valuestoredr.replace("$samplerate$", "variable samplerate")
        self.configManager.setUIConfigParam(uiconf, 'sections[1].content[2].value.value', valuestoredr);
        self.configManager.setUIConfigParam(uiconf, 'sections[1].content[2].value.label', valuestoredrlabel);
        value = self.config.get('attenuationr');
        self.configManager.setUIConfigParam(uiconf, 'sections[1].content[3].value.value', value);
        self.configManager.setUIConfigParam(uiconf, 'sections[1].content[3].value.label', value);


        for (let n = 0; n < 22; n = n + 0.5) {
          self.configManager.pushUIConfigParam(uiconf, 'sections[1].content[1].options', {
            value: (n),
            label: (n)
          });
          self.configManager.pushUIConfigParam(uiconf, 'sections[1].content[3].options', {
            value: (n),
            label: (n)
          });

        }
        try {

          fs.readdir(filterfolder, function (err, item) {
            let allfilter = 'None,' + item;
            let litems = allfilter.split(',');
            for (let a in litems) {

              self.configManager.pushUIConfigParam(uiconf, 'sections[1].content[0].options', {
                value: litems[a],
                label: litems[a]
              });
              self.configManager.pushUIConfigParam(uiconf, 'sections[1].content[2].options', {
                value: litems[a],
                label: litems[a]
              });
            }
          });
        } catch (e) {
          self.logger.error(logPrefix + ' CAN not read file: ' + e)
        }
        uiconf.sections[1].content[4].value = self.config.get('enableclipdetect');

        uiconf.sections[1].saveButton.data.push('leftfilter');
        uiconf.sections[1].saveButton.data.push('attenuationl');
        uiconf.sections[1].saveButton.data.push('rightfilter');
        uiconf.sections[1].saveButton.data.push('attenuationr');
        uiconf.sections[1].saveButton.data.push('enableclipdetect');

        //----------------end of convfir section------------

        //----------------Pure CamillaDsp section------------
      } else if (selectedsp == "purecgui") {

        var IPaddress = self.config.get('address')
        var purecamillainstalled = self.config.get('purecgui')
        uiconf.sections[1].hidden = true;
        uiconf.sections[2].hidden = true;
        uiconf.sections[3].hidden = true;
        uiconf.sections[4].hidden = true;
        uiconf.sections[5].hidden = true;
        uiconf.sections[6].hidden = true;
        uiconf.sections[7].hidden = true;
        uiconf.sections[8].hidden = true;

        if (purecamillainstalled == true) {

          self.logger.info(logPrefix + ' IP adress is ---------------------------' + IPaddress)
          uiconf.sections[9].content.push(
            {
              "id": "camillagui",
              "element": "button",
              "label": "Access to Camilla Gui",
              "doc": "CamillaGui",
              "onClick": {
                "type": "openUrl",
                "url": "http://" + IPaddress + ":5011"
              }
            }
          )
        } else if (purecamillainstalled == false) {
          uiconf.sections[9].content.push(

            {
              "id": "installcamillagui",
              "element": "button",
              "label": "First use. Install Camilla GUI",
              "doc": "First use. Install Camilla GUI",
              "onClick": {
                "type": "plugin",
                "endpoint": "audio_interface/fusiondsp",
                "method": "installcamillagui",
                "data": [],

              }
            }
          )
        }
      }

      //---------------more settings---------------------
      var moresettings = self.config.get('moresettings')
      if ((moresettings == false) && (selectedsp != "EQ3")) {
        uiconf.sections[1].content.push(
          {
            "id": "moresettings",
            "element": "button",
            "label": self.commandRouter.getI18nString('MORE_SETTINGS'),
            "doc": self.commandRouter.getI18nString('MORE_SETTINGS_DOC'),
            "onClick": {
              "type": "plugin",
              "endpoint": "audio_interface/fusiondsp",
              "method": "moresettings",
              "data": [],

            },
            "visibleIf": {
              "field": "showeq",
              "value": true
            }
          }
        )
      } else if ((moresettings) && (selectedsp != "EQ3")) {
        uiconf.sections[1].content.push(
          {
            "id": "lesssettings",
            "element": "button",
            "label": self.commandRouter.getI18nString('LESS_SETTINGS'),
            "doc": self.commandRouter.getI18nString('LESS_SETTINGS_DOC'),
            "onClick": {
              "type": "plugin",
              "endpoint": "audio_interface/fusiondsp",
              "method": "lesssettings",
              "data": []
            },
            "visibleIf": {
              "field": "showeq",
              "value": true
            }
          }
        )
      }

      if (moresettings) {


        //-----------------crossfeed -------------
        var crossconfig = self.config.get('crossfeed')
        switch (crossconfig) {
          case ("None"):
            var crosslabel = 'None'
            break;
          case ("bauer"):
            var crosslabel = "Bauer 700Hz/4.5dB"
            break;
          case ("chumoy"):
            var crosslabel = "Chu Moy 700Hz/6dB"
            break;
          case ("jameier"):
            var crosslabel = "Jan Meier 650Hz/9.5dB"
            break;
          case ("linkwitz"):
            var crosslabel = "Linkwitz 700Hz/2dB"
            break;
          case ("nc_11_30"):
            var crosslabel = "Natural Crossfeed 1.1, 30 deg"
            break;
          case ("nc_11_50"):
            var crosslabel = "Natural Crossfeed 1.1, 50 deg"
            break;
          case ("sadie_d1"):
            var crosslabel = "SADIE D1 HRTF (KU100 Dummy Head)"
            break;
          case ("sadie_h15m"):
            var crosslabel = "SADIE H15m HRTF (Human Subject)"
            break;
          default: "None"
        }
        if (selectedsp != "convfir") {
          uiconf.sections[1].content.push(
            {
              "id": "autoatt",
              "element": "switch",
              "doc": self.commandRouter.getI18nString('AUTO_ATT_DOC'),
              "label": self.commandRouter.getI18nString('AUTO_ATT'),
              "value": self.config.get('autoatt'),
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            }
          )
        }
        uiconf.sections[1].content.push(

          {
            "id": "monooutput",
            "element": "switch",
            "doc": self.commandRouter.getI18nString('MONOOUTPUT_DOC'),
            "label": self.commandRouter.getI18nString('MONOOUTPUT'),
            "value": self.config.get('monooutput'),
            "visibleIf": {
              "field": "showeq",
              "value": true
            }
          },
          {
            "id": "permutchannel",
            "element": "switch",
            "doc": self.commandRouter.getI18nString('PERMUT_CHANNEL_DOC'),
            "label": self.commandRouter.getI18nString('PERMUT_CHANNEL'),
            "value": self.config.get('permutchannel'),
            "visibleIf": {
              "field": "showeq",
              "value": true
            }
          },
          {
            "id": "muteleft",
            "element": "switch",
            "doc": self.commandRouter.getI18nString('MUTE_LEFT_DOC'),
            "label": self.commandRouter.getI18nString('MUTE_LEFT'),
            "value": self.config.get('muteleft'),
            "visibleIf": {
              "field": "showeq",
              "value": true
            }
          },
          {
            "id": "muteright",
            "element": "switch",
            "doc": self.commandRouter.getI18nString('MUTE_RIGHT_DOC'),
            "label": self.commandRouter.getI18nString('MUTE_RIGHT'),
            "value": self.config.get('muteright'),
            "visibleIf": {
              "field": "showeq",
              "value": true
            }
          },
          {
            "id": "crossfeed",
            "element": "select",
            "doc": self.commandRouter.getI18nString('CROSSFEED_DOC'),
            "label": self.commandRouter.getI18nString('CROSSFEED'),
            "value": { "value": self.config.get('crossfeed'), "label": crosslabel },
            "options": [{ "value": "None", "label": "None" }, { "value": "bauer", "label": "Bauer 700Hz/4.5dB" }, { "value": "chumoy", "label": "Chu Moy 700Hz/6dB" }, { "value": "jameier", "label": "Jan Meier 650Hz/9.5dB" }, { "value": "linkwitz", "label": "Linkwitz 700Hz/2dB" }, { "value": "nc_11_30", "label": "Natural Crossfeed 1.1, 30 deg" }, { "value": "nc_11_50", "label": "Natural Crossfeed 1.1, 50 deg" }, { "value": "sadie_d1", "label": "SADIE D1 HRTF (KU100 Dummy Head)" }, { "value": "sadie_h15m", "label": "SADIE H15m HRTF (Human Subject)" }],
            "visibleIf": {
              "field": "showeq",
              "value": true
            }
          }
        )
        if (self.config.get('showloudness')) {
          uiconf.sections[1].content.push(

            {
              "id": "loudness",
              "element": "switch",
              "doc": self.commandRouter.getI18nString('LOUDNESS_DOC'),
              "label": self.commandRouter.getI18nString('LOUDNESS'),
              "value": self.config.get('loudness'),
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            },
            {
              "id": "loudnessthreshold",
              "element": "equalizer",
              "label": self.commandRouter.getI18nString("LOUDNESS_THRESHOLD"),
              "doc": self.commandRouter.getI18nString('LOUDNESS_THRESHOLD_DOC'),
              "visibleIf": {
                "field": "showeq",
                "value": true
              },
              "config": {
                "orientation": "horizontal",
                "bars": [
                  {
                    "min": "10",
                    "max": "100",
                    "step": "1",
                    "value": self.config.get('loudnessthreshold'),
                    "ticksLabels": [
                      "%"
                    ],
                    "tooltip": "always"
                  }
                ]
              }
            }
          )
        }
        if (self.config.get('manualdelay') == false) {

          uiconf.sections[1].content.push(
            {
              "id": "manualdelay",
              "element": "button",
              "label": self.commandRouter.getI18nString('DELAY_MANUAL'),
              "doc": self.commandRouter.getI18nString('DELAY_MANUAL_DOC'),
              "onClick": {
                "type": "plugin",
                "endpoint": "audio_interface/fusiondsp",
                "method": "manualdelay",
                "data": []
              },
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            },
            {
              "id": "ldistance",
              "element": "input",
              "type": "number",
              "label": self.commandRouter.getI18nString('DELAY_LEFT_SPEAKER_DIST'),
              "doc": self.commandRouter.getI18nString('DELAY_LEFT_SPEAKER_DIST_DOC'),
              "attributes": [
                { "placeholder": "0 centimeter" },
                { "maxlength": 5 },
                { "min": 0 },
                { "step": 1 }
              ],
              "value": self.config.get("ldistance"),
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            },
            {
              "id": "rdistance",
              "element": "input",
              "type": "number",
              "label": self.commandRouter.getI18nString('DELAY_RIGHT_SPEAKER_DIST'),
              "doc": self.commandRouter.getI18nString('DELAY_RIGHT_SPEAKER_DIST_DOC'),
              "attributes": [
                { "placeholder": "0 centimeter" },
                { "maxlength": 5 },
                { "min": 0 },
                { "step": 1 }
              ],
              "value": self.config.get("rdistance"),
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            }
          )
          uiconf.sections[1].saveButton.data.push('ldistance');
          uiconf.sections[1].saveButton.data.push('rdistance');
        }

        if (self.config.get('manualdelay')) {
          uiconf.sections[1].content.push(

            {
              "id": "speakerdistance",
              "element": "button",
              "label": self.commandRouter.getI18nString('DELAY_AUTO'),
              "doc": self.commandRouter.getI18nString('DELAY_AUTO_DOC'),
              "onClick": {
                "type": "plugin",
                "endpoint": "audio_interface/fusiondsp",
                "method": "speakerdistance",
                "data": []
              },
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            },
            {
              "id": "delayscope",
              "element": "select",
              "doc": self.commandRouter.getI18nString('DELAY_SCOPE_DOC'),
              "label": self.commandRouter.getI18nString('DELAY_SCOPE'),
              "value": { "value": self.config.get("delayscope"), "label": self.config.get("delayscope") },
              "options": [{ "value": "None", "label": "None" }, { "value": "L", "label": "L" }, { "value": "R", "label": "R" }, { "value": "L+R", "label": "L+R" }],
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            },
            {
              "id": "delay",
              "element": "input",
              "type": "number",
              "label": self.commandRouter.getI18nString('DELAY_VALUE'),
              "doc": self.commandRouter.getI18nString("DELAY_VALUE_DOC"),
              "attributes": [
                { "placeholder": "0ms" },
                { "maxlength": 4 },
                { "min": 0 },
                { "max": 1000.1 },
                { "step": 0.1 }
              ],
              "value": self.config.get("delay"),
              "visibleIf": {
                "field": "showeq",
                "value": true
              }
            }
          )
        }
        uiconf.sections[1].saveButton.data.push('delay');
        uiconf.sections[1].saveButton.data.push('delayscope');

      }
      //------------experimental

      var devicename = self.commandRouter.sharedVars.get('system.name');

      //-----------------

      // }
      // self.logger.info(logPrefix + ' effect ' + effect)

      if (effect == true) {
        uiconf.sections[1].content.push(
          {
            "id": "disableeffect",
            "element": "button",
            "label": self.commandRouter.getI18nString('DISABLE_EFFECT'),
            "doc": self.commandRouter.getI18nString('DISABLE_EFFECT_DESC'),
            "onClick": {
              "type": "plugin",
              "endpoint": "audio_interface/fusiondsp",
              "method": "disableeffect",
              "data": []
            }
          }
        )
      } else if (effect == false) {
        uiconf.sections[1].content.push(
          {
            "id": "enableeffect",
            "element": "button",
            "label": self.commandRouter.getI18nString('ENABLE_EFFECT'),
            "doc": self.commandRouter.getI18nString('ENABLE_EFFECT_DESC'),
            "onClick": {
              "type": "plugin",
              "endpoint": "audio_interface/fusiondsp",
              "method": "enableeffect",
              "data": []
            }
          }
        )
      }
      if (moresettings) {

        uiconf.sections[1].content.push(
          {
            "id": "leftlevel",
            "element": "input",
            "type": "number",
            "label": self.commandRouter.getI18nString("LEFTLEVEL"),
            "doc": self.commandRouter.getI18nString('LEFTLEVEL_DESC'),
            "visibleIf": {
              "field": "showeq",
              "value": true
            },
            "attributes": [
              { "placeholder": {} },
              { "maxlength": {} },
              { "min": -20 },
              { "max": 0 },
              { "step": 0.5 }
            ],
            "value": self.config.get('leftlevel')

          },
          {
            "id": "rightlevel",
            "element": "input",
            "type": "number",
            "label": self.commandRouter.getI18nString('RIGHTLEVEL'),
            "doc": self.commandRouter.getI18nString("RIGHTLEVEL_DESC"),
            "visibleIf": {
              "field": "showeq",
              "value": true
            },
            "attributes": [
              { "placeholder": {} },
              { "maxlength": {} },
              { "min": -20 },
              { "max": 0 },
              { "step": 0.5 }
            ],
            "value": self.config.get('rightlevel')

          }
        )
      }
      if (selectedsp != "EQ3") {

        uiconf.sections[1].content.push(

          {
            "id": "showeq",
            "element": "switch",
            "doc": self.commandRouter.getI18nString('SHOW_SETTINGS_DOC'),
            "label": self.commandRouter.getI18nString('SHOW_SETTINGS'),
            "value": self.config.get('showeq')
          }
        )

        uiconf.sections[1].saveButton.data.push('autoatt');
        uiconf.sections[1].saveButton.data.push('leftlevel');
        uiconf.sections[1].saveButton.data.push('rightlevel');
        uiconf.sections[1].saveButton.data.push('crossfeed');
        uiconf.sections[1].saveButton.data.push('monooutput');
        uiconf.sections[1].saveButton.data.push('muteleft');
        uiconf.sections[1].saveButton.data.push('muteright');
        uiconf.sections[1].saveButton.data.push('permutchannel');




        if (self.config.get('showloudness')) {
          uiconf.sections[1].saveButton.data.push('loudness');
          uiconf.sections[1].saveButton.data.push('loudnessthreshold');
        }
        // }
        uiconf.sections[1].saveButton.data.push('showeq');
      }

      //--------section 2-------------------

      var value = self.config.get('usethispreset');
      const pFolder = presetFolder + "/" + selectedsp;
      var plabel = (self.config.get(selectedsp + "preset") || "")
        .replace(/^\./, "")
        .replace(/\.json$/, "");
      self.logger.info(logPrefix + plabel)
      self.configManager.setUIConfigParam(uiconf, 'sections[2].content[0].value.value', value);
      self.configManager.setUIConfigParam(uiconf, 'sections[2].content[0].value.label', plabel);

      try {

        fs.readdir(pFolder, function (err, item) {
          let allpreset = '' + item;
          let items = allpreset.split(',');
          let itemsf = items.map(item => item.replace(/^\./, "").replace(/\.json$/, ""));
          self.logger.info(logPrefix + items)

          for (let i in items) {

            self.configManager.pushUIConfigParam(uiconf, 'sections[2].content[0].options', {
              value: items[i],
              label: itemsf[i]
            });
          }
        });
      } catch (err) {
        self.logger.error(logPrefix + ' failed to read local file' + err);
      }

      //-------------section 3-----------savepreset


      uiconf.sections[3].content[0].value = self.config.get('renpreset');

      //-----------section 4---------
      value = self.config.get('importeq');
      var label = self.commandRouter.getI18nString('CHOOSE_HEADPHONE')
      self.configManager.setUIConfigParam(uiconf, 'sections[4].content[0].value.value', value);
      self.configManager.setUIConfigParam(uiconf, 'sections[4].content[0].value.label', value);


      try {
        let listf = fs.readFileSync('/data/plugins/audio_interface/fusiondsp/downloadedlist.txt', "utf8");
        var result = (listf.split('\n'));
        let i;

        for (i = 15; i < result.length; i++) {
          var preparedresult = result[i].replace(/- \[/g, "").replace("](.", ",").slice(0, -1);

          var param = preparedresult.split(',')
          var namel = (param[0])
          var linkl = param[1]

          self.configManager.pushUIConfigParam(uiconf, 'sections[4].content[0].options', {
            value: linkl,
            label: +i - 14 + "  " + namel
          });
        }


      } catch (err) {
        self.logger.error(logPrefix + ' failed to read downloadedlist.txt' + err);
      }

      //----------section 5------------
      value = self.config.get('importlocal');
      var label = self.commandRouter.getI18nString('CHOOSE_LOCALEQ')

      self.configManager.setUIConfigParam(uiconf, 'sections[5].content[0].value.value', value);
      self.configManager.setUIConfigParam(uiconf, 'sections[5].content[0].value.label', label);


      var localEQfolder = '/data/INTERNAL/FusionDsp/peq'
      try {
        fs.readdir(localEQfolder, function (err, item) {

          let allfilter = '' + item;
          let items = allfilter.split(',');
          for (let i in items) {

            self.configManager.pushUIConfigParam(uiconf, 'sections[5].content[0].options', {
              value: items[i],
              label: items[i]
            });
          }

        });
      } catch (err) {
        self.logger.error(logPrefix + ' failed to read local file' + err);
      }

      value = self.config.get('localscope');
      self.configManager.setUIConfigParam(uiconf, 'sections[5].content[1].value.value', value);
      self.configManager.setUIConfigParam(uiconf, 'sections[5].content[1].value.label', value);

      let sitemsl = ('L,R,L+R').split(',');
      for (let i in sitemsl) {
        self.configManager.pushUIConfigParam(uiconf, 'sections[5].content[1].options', {
          value: sitemsl[i],
          label: sitemsl[i]
        });
      }

      var addreplace = self.config.get('addreplace')
      uiconf.sections[5].content[2].value = addreplace;

      //-------------End section 5--------------


      //-------------Section 6--------------
      uiconf.sections[6].content[0].value = self.config.get('enableresampling');
      value = self.config.get('resamplingset');
      self.configManager.setUIConfigParam(uiconf, 'sections[6].content[1].value.value', value);
      self.configManager.setUIConfigParam(uiconf, 'sections[6].content[1].value.label', value);

      let sampleratelist = self.config.get('probesmplerate')
      let samplerate = sampleratelist.split(' ')
      for (let n in samplerate) {
        self.configManager.pushUIConfigParam(uiconf, 'sections[6].content[1].options', {
          value: samplerate[n],
          label: samplerate[n]
        })
      }
      value = self.config.get('resamplingq');
      self.configManager.setUIConfigParam(uiconf, 'sections[6].content[2].value.value', value);
      self.configManager.setUIConfigParam(uiconf, 'sections[6].content[2].value.label', value);

      let resamplingqlist = ('+,++,+++')
      let resamplingq = resamplingqlist.split(',')
      for (let n in samplerate) {
        self.configManager.pushUIConfigParam(uiconf, 'sections[6].content[2].options', {
          value: resamplingq[n],
          label: resamplingq[n]
        })
      }
      //-------------End section 6----------

      //--------------section 7-------------


      var filetoconvertl = self.config.get('filetoconvert');
      self.configManager.setUIConfigParam(uiconf, 'sections[7].content[0].value.value', filetoconvertl);
      self.configManager.setUIConfigParam(uiconf, 'sections[7].content[0].value.label', filetoconvertl);
      try {
        fs.readdir(filtersource, function (err, fitem) {
          let fitems;
          let filetoconvert = '' + fitem;
          fitems = filetoconvert.split(',');
          // console.log(fitems)
          for (let i in fitems) {
            self.configManager.pushUIConfigParam(uiconf, 'sections[7].content[0].options', {
              value: fitems[i],
              label: fitems[i]
            });
            //  self.logger.info(logPrefix+' available impulses to convert :' + fitems[i]);
          }
        });
      } catch (e) {
        self.logger.error(logPrefix + ' Could not read file: ' + e)
      }

      var value = self.config.get('drc_sample_rate');
      self.configManager.setUIConfigParam(uiconf, 'sections[7].content[1].value.value', value);
      self.configManager.setUIConfigParam(uiconf, 'sections[7].content[1].value.label', self.getLabelForSelect(self.configManager.getValue(uiconf, 'sections[7].content[1].options'), value));


      var tc = self.config.get('tc');
      self.configManager.setUIConfigParam(uiconf, 'sections[7].content[2].value.value', tc);
      self.configManager.setUIConfigParam(uiconf, 'sections[7].content[2].value.label', tc);
      try {
        fs.readdir(tccurvepath, function (err, bitem) {
          let bitems;
          let filetoconvert = '' + bitem;
          bitems = filetoconvert.split(',');
          for (let i in bitems) {
            self.configManager.pushUIConfigParam(uiconf, 'sections[7].content[2].options', {
              value: bitems[i],
              label: bitems[i]
            });

          }
        });
      } catch (e) {
        self.logger.error(logPrefix + ' Could not read file: ' + e)
      }

      var value = self.config.get('drcconfig');
      self.configManager.setUIConfigParam(uiconf, 'sections[7].content[3].value.value', value);
      self.configManager.setUIConfigParam(uiconf, 'sections[7].content[3].value.label', self.getLabelForSelect(self.configManager.getValue(uiconf, 'sections[7].content[3].options'), value));
      uiconf.sections[7].content[4].value = self.config.get('outputfilename');
      //-------------end section 7----------

      //-------------section 8------------
      let ttools = self.config.get('toolsinstalled');

      let toolsfiletoplay = self.config.get('toolsfiletoplay');
      self.configManager.setUIConfigParam(uiconf, 'sections[8].content[0].value.value', toolsfiletoplay);
      self.configManager.setUIConfigParam(uiconf, 'sections[8].content[0].value.label', toolsfiletoplay);

      try {
        fs.readdir('/data/' + toolspath, function (err, bitem) {
          let filetools = '' + bitem;

          let bitems = filetools.replace('folder.png', '').slice(0, -1).split(',');

          //console.log(bitems)
          for (let i in bitems) {
            self.configManager.pushUIConfigParam(uiconf, 'sections[8].content[0].options', {
              value: bitems[i],
              label: bitems[i]
            });
            //  self.logger.info(logPrefix+' tools file to play :' + bitems[i]);

          }
        });
      } catch (e) {
        self.logger.error(logPrefix + ' Could not read file: ' + e)
      }


      if (ttools == false) {
        uiconf.sections[8].content[0].hidden = true;

        uiconf.sections[8].content[1].hidden = true;
        uiconf.sections[8].content[2].hidden = false;

      } else {
        uiconf.sections[8].content[1].hidden = false;
        uiconf.sections[8].content[2].hidden = true;

      }
      //--------------end section 8----------
      defer.resolve(uiconf);
    })
    .fail(function (e) {
      self.logger.info(logPrefix + 'Error: ' + e);
      defer.reject(new Error());
    })
  return defer.promise;
};

FusionDsp.prototype.refreshUI = function () {
  const self = this;

  setTimeout(function () {
    var respconfig = self.commandRouter.getUIConfigOnPlugin('audio_interface', 'fusiondsp', {});
    respconfig.then(function (config) {
      self.commandRouter.broadcastMessage('pushUiConfig', config);
    });
    self.commandRouter.closeModals();
  }, 110);
}

FusionDsp.prototype.choosedsp = function (data) {
  const self = this;
  let selectedsp = (data['selectedsp'].value)

  if (selectedsp === 'EQ3') {
    self.config.set('nbreq', 3)
    if
      (self.config.get('savedmergedgeqx3') == undefined) {
      self.config.set('mergedeq', '0,0,0')
    } else {
      self.config.set('mergedeq', self.config.get('savedmergedgeqx3'))
    }
    if
      (self.config.get('savedgeq3') == undefined) {
      self.config.set('geq3', '0,0,0')
    } else {
      self.config.set('geq3', self.config.get('savedgeq3'))
    }
    // self.config.set('geq3', self.config.get('savedgeq3'))
    self.config.set('crossfeed', "None")
    self.config.set('monooutput', false)
    self.config.set('loudness', false)
    self.config.set('loudnessthreshold', 50)
    self.config.set('leftlevel', 0)
    self.config.set('rightlevel', 0)
    self.config.set('delay', 0)
    self.config.set('delayscope', "None")
    self.config.set('autoatt', true)
    self.config.set('muteleft', false)
    self.config.set('muteright', false)
    self.config.set('ldistance', 0)
    self.config.set('rdistance', 0)
    self.config.set('permutchannel', false)
    self.config.set('moresettings', false)

  } else if (selectedsp === 'EQ15') {
    self.config.set("showeq", true)

    self.config.set('nbreq', 15)
    self.config.set('mergedeq', self.config.get('savedmergedgeq15'))
    self.config.set('geq15', self.config.get('savedgeq15'))

  } else if (selectedsp === '2XEQ15') {
    self.config.set("showeq", true)
    self.config.set('nbreq', 30)
    self.config.set('geq15', self.config.get('savedx2geq15l'))
    self.config.set('mergedeq', self.config.get('savedmergedeqx2geq15'))
    self.config.set('x2geq15', self.config.get('savedx2geq15r'))

  } else if (selectedsp === 'PEQ') {
    self.config.set("showeq", true)
    self.config.set('nbreq', self.config.get('savednbreq'))
    self.config.set('mergedeq', self.config.get('savedmergedeq'))

  } else if (selectedsp === 'convfir') {
    self.config.set("showeq", true)
    self.config.set('nbreq', 2),
      self.config.set('mergedeq', self.config.get('savedmergedeqfir'))

  } else if (selectedsp === 'purecgui') {
    self.logger.info(logPrefix + ' Launching CamillaDsp GUI')
    self.purecamillagui()
  }

  self.config.set('effect', true)
  self.config.set('selectedsp', selectedsp)

  setTimeout(function () {
    self.createCamilladspfile()
  }, 100);

  self.refreshUI();
};

FusionDsp.prototype.getIP = function () {
  const self = this;
  var address
  var iPAddresses = self.commandRouter.executeOnPlugin('system_controller', 'network', 'getCachedIPAddresses', '');
  if (iPAddresses && iPAddresses.eth0 && iPAddresses.eth0 != '') {
    address = iPAddresses.eth0;
  } else if (iPAddresses && iPAddresses.wlan0 && iPAddresses.wlan0 != '' && iPAddresses.wlan0 !== '192.168.211.1') {
    address = iPAddresses.wlan0;
  } else {
    address = '127.0.0.1';
  }
  self.config.set('address', address)
};

FusionDsp.prototype.purecamillagui = function () {
  const self = this;
  let defer = libQ.defer();

  //-----------Experimental CamillaGui

  try {
    exec("/usr/bin/sudo /bin/systemctl start fusiondsp.service", {
      uid: 1000,
      gid: 1000
    });
    self.commandRouter.pushConsoleMessage('FusionDsp loaded');
    defer.resolve();
  } catch (err) {
    self.logger.info(logPrefix + ' failed to load Camilla Gui' + err);
  }

};

FusionDsp.prototype.addeq = function (data) {
  const self = this;
  var n = self.config.get('nbreq')
  n = n + 1;
  if (n > tnbreq) {
    self.logger.info(logPrefix + ' Max eq reached!')
    return
  }
  self.config.set('nbreq', n)
  self.config.set('effect', true)
  self.logger.info(logPrefix + ' nbre eq ' + n)

  setTimeout(function () {
    self.createCamilladspfile()
  }, 100);
  self.refreshUI();
};

FusionDsp.prototype.removeeq = function () {
  const self = this;
  var n = self.config.get('nbreq')
  n = n - 1;
  if (n < 1) {
    self.logger.info(logPrefix + ' Min eq reached!')
    return
  }
  self.config.set('effect', true)
  self.config.set('nbreq', n)

  setTimeout(function () {
    self.createCamilladspfile()
  }, 100);
  self.refreshUI();
};

FusionDsp.prototype.removealleq = function () {
  const self = this;

  self.config.set('effect', true)
  self.config.set('nbreq', 1)
  self.config.set('mergedeq', "Eq0|None|L+R|0,0,0|")
  self.config.set('savedmergedeq', "Eq0|None|L+R|0,0,0|")
  self.config.set('savednbreq', 1)
  self.config.set('usethispreset', 'no preset used');

  setTimeout(function () {
    self.createCamilladspfile()
  }, 100);
  self.refreshUI();
};

FusionDsp.prototype.reseteq = function () {
  const self = this;
  if (self.config.get("selectedsp") == 'EQ15') {
    self.config.set('usethispreset', 'no preset used');
    self.config.set("geq15", "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0")
    self.config.set("savedgeq15", "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0")
    self.config.set('nbreq', 15)
    self.config.set('mergedeq', "Eq0|Peaking|L+R|25,0,1.85|Eq1|Peaking|L+R|40,0,1.85|Eq2|Peaking|L+R|63,0,1.85|Eq3|Peaking|L+R|100,0,1.85|Eq4|Peaking|L+R|160,0,1.85|Eq5|Peaking|L+R|250,0,1.85|Eq6|Peaking|L+R|400,0,1.85|Eq7|Peaking|L+R|630,0,1.85|Eq8|Peaking|L+R|1000,0,1.85|Eq9|Peaking|L+R|1600,0,1.85|Eq10|Peaking|L+R|2500,0,1.85|Eq11|Peaking|L+R|4000,0,1.85|Eq12|Peaking|L+R|6300,0,1.85|Eq13|Peaking|L+R|10000,0,1.85|Eq14|Peaking|L+R|16000,0,1.85|")
  }
  if (self.config.get("selectedsp") == '2XEQ15') {
    self.config.set('usethispreset', 'no preset used');
    self.config.set("x2geq15", "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0")
    self.config.set("geq15", "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0")
    self.config.set('nbreq', 30)
    self.config.set('mergedeq', "Eq0|Peaking|L|25,0,1.85|Eq1|Peaking|L|40,0,1.85|Eq2|Peaking|L|63,0,1.85|Eq3|Peaking|L|100,0,1.85|Eq4|Peaking|L|160,0,1.85|Eq5|Peaking|L|250,0,1.85|Eq6|Peaking|L|400,0,1.85|Eq7|Peaking|L|630,0,1.85|Eq8|Peaking|L|1000,0,1.85|Eq9|Peaking|L|1600,0,1.85|Eq10|Peaking|L|2500,0,1.85|Eq11|Peaking|L|4000,0,1.85|Eq12|Peaking|L|6300,0,1.85|Eq13|Peaking|L|10000,0,1.85|Eq14|Peaking|L|16000,0,1.85|undefinedEq0|Peaking|R|25,0,1.85|Eq1|Peaking|R|40,0,1.85|Eq2|Peaking|R|63,0,1.85|Eq3|Peaking|R|100,0,1.85|Eq4|Peaking|R|160,0,1.85|Eq5|Peaking|R|250,0,1.85|Eq6|Peaking|R|400,0,1.851|Eq7|Peaking|R|630,0,1.85|Eq8|Peaking|R|1000,0,1.85|Eq9|Peaking|R|1600,0,1.85|Eq10|Peaking|R|2500,0,1.85|Eq11|Peaking|R|4000,0,1.85|Eq12|Peaking|R|6300,0,1.85|Eq13|Peaking|R|10000,0,1.85|Eq14|Peaking|R|16000,0,1.85|")
  }
  setTimeout(function () {
    self.createCamilladspfile()
    self.refreshUI();
  }, 300);

};

FusionDsp.prototype.moresettings = function () {
  const self = this;
  self.config.set('moresettings', true)
  setTimeout(function () {
    self.createCamilladspfile()
  }, 100);
  self.refreshUI();

};

FusionDsp.prototype.lesssettings = function () {
  const self = this;
  self.config.set('moresettings', false)
  setTimeout(function () {
    self.createCamilladspfile()
  }, 100);
  self.refreshUI();

};

FusionDsp.prototype.enableeffect = function () {
  const self = this;
  self.config.set('effect', true)
  setTimeout(function () {
    self.createCamilladspfile()
  }, 100);
  self.refreshUI();

};

FusionDsp.prototype.disableeffect = function () {
  const self = this;
  self.config.set('effect', false)
  setTimeout(function () {
    self.createCamilladspfile()
  }, 100);
  self.refreshUI();

};

FusionDsp.prototype.speakerdistance = function () {
  const self = this;
  self.config.set('manualdelay', false)
  self.refreshUI();

};

FusionDsp.prototype.manualdelay = function () {
  const self = this;
  self.config.set('manualdelay', true)
  self.refreshUI();

};

FusionDsp.prototype.autocalculdelay = function () {
  const self = this;
  let delay
  let sldistance = self.config.get('ldistance');
  let srdistance = self.config.get('rdistance');
  let diff;
  let cdelay;
  // let sv = 34300; // sound velocity cm/s

  if (sldistance > srdistance) {
    diff = sldistance - srdistance
    cdelay = (diff * 1000 / sv).toFixed(4)
    delay = ('0,' + cdelay)
    self.logger.info(logPrefix + ' l>r ' + delay)
    self.config.set('delayscope', 'R')
    self.config.set('delay', cdelay)

  }
  if (sldistance < srdistance) {
    diff = srdistance - sldistance
    cdelay = (diff * 1000 / sv).toFixed(4)
    delay = (cdelay + ',0')
    self.logger.info(logPrefix + ' l<r ' + delay)
    self.config.set('delayscope', 'L')
    self.config.set('delay', cdelay)
  }
  if (sldistance == srdistance) {
    self.logger.info(logPrefix + ' no delay needed');
    delay = ('0,0')
    self.config.set('delayscope', 'None')
    self.config.set('delay', 0)
    self.config.set('ldistance', 0)
    self.config.set('rdistance', 0)
  }
};

FusionDsp.prototype.autocaldistancedelay = function () {
  const self = this;
  let delays = self.config.get('delay');
  let delayscopes = self.config.get('delayscope');
  let cdistance


  if (delayscopes == "R") {
    cdistance = (delays * 1000000 / sv).toFixed(0)
    self.config.set('ldistance', cdistance)
    self.config.set('rdistance', 0)
  }
  if (delayscopes == "L") {
    cdistance = (delays * 1000000 / sv).toFixed(0)
    self.config.set('rdistance', cdistance)
    self.config.set('ldistance', 0)
  }
  if (delayscopes == "None") {
    self.config.set('ldistance', 0)
    self.config.set('rdistance', 0)
  }
};

FusionDsp.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

FusionDsp.prototype.setUIConfig = function (data) {
  const self = this;
};

FusionDsp.prototype.getConf = function (varName) {
  const self = this;
  //Perform your installation tasks here
};

FusionDsp.prototype.setConf = function (varName, varValue) {
  const self = this;
  //Perform your installation tasks here
};

FusionDsp.prototype.getLabelForSelect = function (options, key) {
  let n = options.length;
  for (let i = 0; i < n; i++) {
    if (options[i].value == key)
      return options[i].label;
  }
  return 'VALUE NOT FOUND BETWEEN SELECT OPTIONS!';
};

FusionDsp.prototype.getAdditionalConf = function (type, controller, data) {
  const self = this;
  return self.commandRouter.executeOnPlugin(type, controller, 'getConfigParam', data);
}
// Plugin methods -----------------------------------------------------------------------------
//------------Here we define a function to send a command to CamillaDsp through websocket---------------------
FusionDsp.prototype.sendCommandToCamilla = function () {
  const self = this;
  const url = 'ws://localhost:9876';
  const connection = new WebSocket(url);
  const ccmd = '\"Reload\"';
  const ccmd2 = '\"GetClippedSamples\"';
  const ccmd3 = '\"GetCaptureSignalPeak\"';

  connection.onopen = () => {
    connection.send(ccmd);
  };

  connection.onerror = (error) => {
    self.logger.error(logPrefix + `WebSocket error: ${error}`);
  };

  connection.onmessage = (e) => {
    self.logger.info(logPrefix + e.data);
    let replyString = Buffer.from(e.data).toString();
    let parsed = {};
    try {
      parsed = JSON.parse(replyString);
    } catch (err) {
      self.logger.error(logPrefix + 'Parse error ', err);
    }
    if (parsed.hasOwnProperty('GetClippedSamples')) {
      let result = parsed.GetClippedSamples.value;
      if (result !== "0") {
        self.logger.info(logPrefix + 'GetCaptureSignalPeak response received', result);
        self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('CLIPPING_WARNING'));
      }
    }
  };
  //connection.close();
  /*
    setInterval(function () {
      connection.onopen = () => {
        connection.send(ccmd2);
        connection.close();
      };
    }, 30000);
    */
};


//------------Fir features----------------

//-----------here we define how to swap filters----------------------

FusionDsp.prototype.areSampleswitch = function () {
  const self = this;
  let leftFilter1 = self.config.get('leftfilter');
  let rightFilter1 = self.config.get('rightfilter');

  // check if filter naming is ok with 44100 in name
  const isFilterSwappable = (filterName, swapWord) => {
    let threeLastChar = filterName.slice(-9, -4);
    if (threeLastChar == swapWord) {
      return true
    }
    else {
      return false
    }
  };
  let leftResult = isFilterSwappable(leftFilter1, '44100');
  let rightResult = isFilterSwappable(rightFilter1, '44100');

  // self.logger.info(leftResult + ' + ' + rightResult);

  // check if secoond filter with 96000 in name
  const isFileExist = (filterName, swapWord) => {
    let fileExt = filterName.slice(-4);
    let filterNameShort = filterName.slice(0, -9);
    let filterNameForSwapc = filterNameShort + swapWord + fileExt;
    let filterNameForSwap = filterNameShort + "$samplerate$" + fileExt;

    if (fs.exists(filterfolder + filterNameForSwap)) {
      return [true, filterNameForSwap]
    } else {
      return false
    }

  };
  let leftResultExist = isFileExist(leftFilter1, '96000');
  let toSaveLeftResult = leftResultExist[1];
  let rightResultExist = isFileExist(rightFilter1, '96000');
  let toSaveRightResult = rightResultExist[1];

  // if conditions are true, switching possible
  if (leftResult & rightResult & leftResultExist[0] & rightResultExist[0]) {
    self.logger.info(logPrefix + ' sample switch possible !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
    self.config.set('leftfilter', toSaveLeftResult);
    self.config.set('rightfilter', toSaveRightResult);
    self.config.set('autoswitchsamplerate', true);
  } else {
    self.config.set('autoswitchsamplerate', false);
  };
  self.refreshUI()
};

//------------Here we detect if clipping occurs while playing ------
FusionDsp.prototype.testclipping = function () {
  const self = this;
  let defer = libQ.defer();
  let messageDisplayed;
  let arrreduced;
  let arr = [];
  let filelength = self.config.get('filter_size');
  let track = '/data/plugins/audio_interface/fusiondsp/testclipping/testclipping.wav';

  setTimeout(function () {
    self.socket.emit('pause');

    self.config.set('loudness', false);
    self.config.set('monooutput', false);
    self.config.set('crossfeed', 'None');
    self.config.set('attenuationl', 0);
    self.config.set('attenuationr', 0);
    self.config.set('muteleft', false);
    self.config.set('muteright', false);
    self.config.set('testclipping', true)

    self.createCamilladspfile();
  }, 300);

  setTimeout(function () {

    try {
      let cmd = ('/usr/bin/aplay -c2 --device=volumio ' + track);
      self.commandRouter.pushToastMessage('info', 'Clipping detection in progress...');
      setTimeout(function () {
        execSync(cmd);
      }, 50);

    } catch (e) {
      self.logger.error(cmd);
    };
  }, 1500);

  setTimeout(function () {

    let rawlog
    try {
      rawlog = fs.readFileSync("/tmp/camilladsp.log", "utf8");
      var o = 0;
      var result = (rawlog.split("\n"));
      for (o; o < result.length; o++) {
        if (result[o].indexOf("Clipping detected") != -1) {

          let filteredMessage = result[o].replace(" dB", ",").replace("peak +", "").split(",");

          let attcalculated = filteredMessage[2]
          messageDisplayed = Number(attcalculated);
          self.logger.info(logPrefix + ' clipping detection gives values in line ' + o + " " + messageDisplayed)
          arr.push(messageDisplayed);
        }
      }

    } catch (err) {
      self.logger.error(logPrefix + ' An error occurs while reading file');
    }

    arr.sort((a, b) => {
      if (a > b) return 1;
      if (a < b) return -1;
      return 0;
    });

    let offset = 3.8;
    let arrreducedr = ((arr.toString().split(',')).pop());
    arrreduced = (+arrreducedr + offset).toFixed(2);

    self.config.set('attenuationl', arrreduced);
    self.config.set('attenuationr', arrreduced);
    self.config.set('testclipping', false)
    self.commandRouter.pushToastMessage('info', self.commandRouter.getI18nString('FILTER_LENGTH') + filelength, self.commandRouter.getI18nString('AUTO_ATTENUATION_SET') + arrreduced + ' dB');

    let ltest, rtest, cleftfilter, crightfilter, test

    cleftfilter = filterfolder + self.config.get('leftfilter')
    crightfilter = filterfolder + self.config.get('rightfilter')

    ltest = ('Eq1' + '|' + 'Conv' + '|L' + cleftfilter + '|' + arrreduced + '|');
    rtest = ('Eq2' + '|' + 'Conv' + '|R' + crightfilter + '|' + arrreduced + '|');
    test = ltest + rtest
    self.config.set('mergedeq', test);
    self.config.set('savedmergedeqfir', test)

    self.refreshUI();
    self.createCamilladspfile();

  }, 8110);
  return defer.promise;

};

//here we determine filter type and apply skip value if needed
FusionDsp.prototype.dfiltertype = function (data) {
  const self = this;
  let skipvalue = '';
  let filtername = self.config.get('leftfilterlabel');
  var auto_filter_format;
  let filext = self.config.get('leftfilterlabel').split('.').pop().toString();
  var wavetype;
  let filelength
  let convtype = "Raw"

  if (filext == 'pcm') {
    try {
      filelength = (execSync('/usr/bin/stat -c%s ' + filterfolder + filtername, 'utf8').slice(0, -1) / 4);
      //  self.logger.info(logPrefix+' filelength ' + filelength)
    } catch (err) {
      self.logger.error(logPrefix + ' An error occurs while reading file');
    }
    self.config.set('filter_size', filelength);
    auto_filter_format = 'FLOAT32LE';
  }
  else if (filext == 'txt') {
    let filelength;
    try {
      filelength = execSync('/bin/cat ' + filterfolder + filtername + ' |wc -l').slice(0, -1);
    } catch (err) {
      self.logger.error(logPrefix + ' An error occurs while reading file');
    }
    self.config.set('filter_size', filelength);
    auto_filter_format = 'TEXT';
    // self.logger.info(logPrefix+' Filter length' + filelength);

  }
  else if (filext == 'raw') {
    try {
      filelength = (execSync('/usr/bin/stat -c%s ' + filterfolder + filtername).slice(0, -1) / 4);
    } catch (err) {
      self.logger.error(logPrefix + ' An error occurs while reading file');
    }
    self.config.set('filter_size', filelength);
    auto_filter_format = 'FLOAT32LE';
  }
  else if (filext == 'dbl') {
    try {
      filelength = (execSync('/usr/bin/stat -c%s ' + filterfolder + filtername).slice(0, -1) / 8);
    } catch (err) {
      self.logger.error(logPrefix + ' An error occurs while reading file');
    }
    self.config.set('filter_size', filelength);
    auto_filter_format = 'FLOAT64LE';
  }
  else if (filext == 'None') {

    auto_filter_format = 'TEXT';
  }
  else if (filext == 'wav') {
    convtype = "Wav"

  } else {
    let modalData = {
      title: self.commandRouter.getI18nString('FILTER_FORMAT_TITLE'),
      message: self.commandRouter.getI18nString('FILTER_FORMAT_MESS'),
      size: 'lg',
      buttons: [{
        name: 'CloseModals',
        class: 'btn btn-warning'
      },]
    };
    self.commandRouter.broadcastMessage("openModal", modalData);
  }

  filelength = self.config.get('filter_size');

  self.config.set('filter_format', auto_filter_format);
  self.config.set('convtype', convtype);

  // self.logger.info(logPrefix+' --------->filter format ' + filext + ' ' + auto_filter_format);
  //self.logger.info(logPrefix+' --------->filter size ' + filelength);


  var arr = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];
  var check = Number(filelength);
  var valfound = false;
  if (arr.indexOf(check) > -1) {
    valfound = true;
  }
  if (valfound) {
    self.logger.info(logPrefix + ' File size found in array!');
  }
  if (valfound === false) {
    self.logger.error(logPrefix + ' File size not found in array!');
  };

  var obj = {
    skipvalue: skipvalue,
    valfound: valfound
  };
  return obj;

};

// Guard against multiple samplerate change events in short amount of time
let isSamplerateUpdating = false;

FusionDsp.prototype.checksamplerate = function () {

  const self = this;

  self.pushstateSamplerate = null;

  /**
   * Callback invoked when fileStreamParams changes. In this callback
   * we read the stream parameters, validate them and update camilladsp
   * configuration file to accomodate changes
   */
  let callbackRead = function (event, file) {

    let hcurrentsamplerate;
    let hformat;
    let hchannels;
    let hbitdepth;
    let needRestart = false;
    let timestamp = null;

    try {

      let content = fs.readFileSync(fileStreamParams).toString();

      self.logger.info(logPrefix + " ---- read samplerate, raw: " + content);

      [hcurrentsamplerate, hformat, hchannels, hbitdepth] = content.split(",");

      if (!hcurrentsamplerate)
        throw "invalid sample rate";

      if (isSamplerateUpdating === true)
        throw " ---- read samplerate skipped, rate is already updating; keeping " + self.pushstateSamplerate;

      isSamplerateUpdating = true;

      if (self.pushstateSamplerate != hcurrentsamplerate)
        needRestart = true;

      self.pushstateSamplerate = hcurrentsamplerate;

      self.logger.info(logPrefix + " ---- read samplerate from file: " + self.pushstateSamplerate);

      if (needRestart === true) {

        // Synchronous stop, the function will return only when the process has been
        // really terminated
        self.camillaProcess.stop();

        self.createCamilladspfile(function () {
          self.camillaProcess.start();
          isSamplerateUpdating = false;
        });


      } else {

        self.createCamilladspfile();
        isSamplerateUpdating = false;

      }

    } catch (e) {

      isSamplerateUpdating = false;
      self.logger.error(logPrefix + e);

    }

  }

  // Install a file watcher over fileStreamParams
  // when the file changes, read the content and update the samplerate
  try {

    let watcher = fs.watch(fileStreamParams);
    watcher.on("change", callbackRead);

    self.logger.info(logPrefix + " ---- installed callbackRead");

  } catch (e) {

    self.logger.error(logPrefix + "### ERROR: could not watch file " + fileStreamParams + " for sampling rate check");

  }

};

let getCamillaFiltersConfig = function (plugin, selectedsp, chunksize, hcurrentsamplerate) {

  let self = plugin;

  var pipeliner, pipelines, pipelinelr, pipelinerr = '';
  var eqo, eqc, eqv, eqa
  var typec, typer;
  var result = '';
  var gainmaxused = [];
  let scopec, scoper;
  var nbreq = (self.config.get('nbreq'))
  var effect = self.config.get('effect')
  var leftlevel = self.config.get('leftlevel')
  var rightlevel = self.config.get('rightlevel')
  //----fIr VARIABLES----
  let leftfilter = self.config.get('leftfilter');
  let filter1 = leftfilter
  let rightfilter = self.config.get('rightfilter');
  let filter2 = rightfilter
  var attenuation = self.config.get('attenuationl');
  var testclipping = self.config.get('testclipping')

  // var smpl_rate = self.config.get('smpl_rate')
  var filter_format = self.config.get('filter_format')
  if (selectedsp == "convfir") {
    let val = self.dfiltertype();
    let skipval = val.skipvalue
  }
  var channels = 2;
  var filterr;
  let convatt
  var gainresult, gainclipfree
  let eqval = self.config.get('mergedeq')
  let subtypex = eqval.toString().split('|')
  let resulttype = ''
  let crossatt, crossfreq
  let loudnessGain = self.config.get('loudnessGain')

  let enableresampling = self.config.get('enableresampling')
  let resamplingq = self.config.get('resamplingq')
  let resamplingset = self.config.get('resamplingset')
  let allowdownsamplig = true
  let autoatt = self.config.get('autoatt')

  //----compose output----
  if (testclipping) {
    var composeout = ''
    composeout += '  playback:' + '\n';
    composeout += '    type: File' + '\n';
    composeout += '    channels: 2' + '\n';
    composeout += '    filename: "/dev/null"' + '\n';
    composeout += '    format: S32LE' + '\n';

  } else if (testclipping == false) {
    var composeout = ''
    composeout += '  playback:' + '\n';
    composeout += '    type: Alsa' + '\n';
    composeout += '    channels: 2' + '\n';
    composeout += '    device: "postDsp"' + '\n';
    composeout += '    format: S32LE' + '\n';
  }
  //------resampling section-----

  var composeddevice = '';
  let capturesamplerate = hcurrentsamplerate;
  let outputsamplerate = capturesamplerate;
  if (enableresampling) {
    let type
    switch (resamplingq) {
      case ("+"):
        type = 'FastAsync'
        break;
      case ("++"):
        type = 'BalancedAsync'
        break;
      case ("+++"):
        type = 'AccurateAsync'
        break;
      default: "++"
    }

    composeddevice += '  enable_resampling: true\n';
    composeddevice += '  resampler_type: ' + type + '\n';
    composeddevice += '  capture_samplerate: ' + capturesamplerate;
    outputsamplerate = resamplingset;
  } else if (enableresampling == false) {
    composeddevice += '  capture_samplerate: ' + capturesamplerate;
    composeddevice = '\n';
  }
  //------crossfeed section------

  var crossconfig = self.config.get('crossfeed')
  var is_natural = crossconfig.includes("nc_") || crossconfig.includes("sadie_")
  if ((crossconfig != 'None') && (!is_natural))/* && (effect))*/ {
    var composedeq = '';

    self.logger.info(logPrefix + ' crossfeed  ' + (self.config.get('crossfeed')))
    switch (crossconfig) {
      case ("bauer"):
        crossfreq = 700
        crossatt = 4.5
        break;
      case ("chumoy"):
        crossfreq = 700
        crossatt = 6
        break;
      case ("jameier"):
        crossfreq = 650
        crossatt = 9.5
        break;
      case ("linkwitz"):
        crossfreq = 700
        crossatt = 2
        break;
      case ("None"):
        crossatt = 0
        //   composedeq += ''
        break;
      default: "None"

    }

    composedeq += '  highcross:\n'
    composedeq += '    type: Biquad\n'
    composedeq += '    parameters:\n'
    composedeq += '      type: Highshelf\n'
    composedeq += '      freq: ' + crossfreq + '\n'
    composedeq += '      slope: 6\n'
    composedeq += '      gain: ' + crossatt + '\n'
    composedeq += '\n'
    composedeq += '  lpcross:\n'
    composedeq += '    type: Biquad\n'
    composedeq += '    parameters:\n'
    composedeq += '      type: LowpassFO\n'
    composedeq += '      freq: ' + crossfreq + '\n'
    composedeq += '\n'
    composedeq += '  delay:\n'
    composedeq += '    type: Delay\n'
    composedeq += '    parameters:\n'
    composedeq += '      delay: 0.32\n'
    composedeq += '      unit: ms\n'
    composedeq += '      subsample: false\n'
    composedeq += '      \n'
    result += composedeq


  }
  if ((crossconfig != 'None') && (is_natural) && (effect)) {
    var composedeq = '';

    let hrtf_filterl = '';
    let hrtf_filterr = '';
    crossatt = 3;

    self.logger.info(logPrefix + ' crossfeed  ' + (self.config.get('crossfeed')))
    switch (crossconfig) {
      case ("nc_11_30"):
        hrtf_filterl = "NC_11_30/NC_11_30_Left_$samplerate$.wav";
        hrtf_filterr = "NC_11_30/NC_11_30_Right_$samplerate$.wav";
        break;
      case ("nc_11_50"):
        hrtf_filterl = "NC_11_50/NC_11_50_Left_$samplerate$.wav";
        hrtf_filterr = "NC_11_50/NC_11_50_Right_$samplerate$.wav";
        break;
      case ("sadie_d1"):
        hrtf_filterl = "SADIE_D1/SADIE_D1_Left_30deg_$samplerate$.wav";
        hrtf_filterr = "SADIE_D1/SADIE_D1_Right_30deg_$samplerate$.wav";
        break;
      case ("sadie_h15m"):
        hrtf_filterl = "SADIE_H15/SADIE_H15_mod_Left_30deg_$samplerate$.wav";
        hrtf_filterr = "SADIE_H15/SADIE_H15_mod_Right_30deg_$samplerate$.wav";
        break;
    }

    composedeq += '  hrtf_conv_ll:\n';
    composedeq += '    type: Conv' + '\n';
    composedeq += '    parameters:' + '\n';
    composedeq += '      type: Wav' + '\n';
    composedeq += '      filename: ' + hrtffilterpath + hrtf_filterl + '\n';
    composedeq += '      channel: 0\n';
    composedeq += '      \n'
    composedeq += '  hrtf_conv_lr:\n';
    composedeq += '    type: Conv' + '\n';
    composedeq += '    parameters:' + '\n';
    composedeq += '      type: Wav' + '\n';
    composedeq += '      filename: ' + hrtffilterpath + hrtf_filterl + '\n';
    composedeq += '      channel: 1\n';
    composedeq += '      \n'
    composedeq += '  hrtf_conv_rl:\n';
    composedeq += '    type: Conv' + '\n';
    composedeq += '    parameters:' + '\n';
    composedeq += '      type: Wav' + '\n';
    composedeq += '      filename: ' + hrtffilterpath + hrtf_filterr + '\n';
    composedeq += '      channel: 0\n';
    composedeq += '      \n'
    composedeq += '  hrtf_conv_rr:\n';
    composedeq += '    type: Conv' + '\n';
    composedeq += '    parameters:' + '\n';
    composedeq += '      type: Wav' + '\n';
    composedeq += '      filename: ' + hrtffilterpath + hrtf_filterr + '\n';
    composedeq += '      channel: 1\n';
    composedeq += '      \n'
    result += composedeq

  } else {
    crossatt = 0
    composedeq += ''
  }

  //------end crossfeed section

  //------delay
  let delayscope = self.config.get('delayscope')
  if (delayscope != 'None') {
    var composedeq = '';
    var pipelineL = '';
    var pipelineR = '';
    composedeq += '  delayG' + ':\n';
    composedeq += '    type: Delay' + '\n';
    composedeq += '    parameters:' + '\n';
    composedeq += '      delay: ' + self.config.get("delay") + '\n';
    composedeq += '      unit: ms' + '\n';
    composedeq += '      subsample: false' + '\n';
    composedeq += '' + '\n';
    result += composedeq

  }
  //-----end delay

  //------volume loudness section---

  let loudness = self.config.get('loudness')
  if ((loudness) && (effect)) {
    self.logger.info(logPrefix + ' Loudness is ON ' + loudness)
    var composedeq = '';
    var pipelineL = '';
    var pipelineR = '';

    composedeq += '  highshelf:\n'
    composedeq += '    type: Biquad\n'
    composedeq += '    parameters:\n'
    composedeq += '      type: Highshelf\n'
    composedeq += '      freq: 10620\n'
    composedeq += '      q: 1.38\n'
    composedeq += '      gain: ' + ((loudnessGain * 0.2811168954093706)).toFixed(2) + '\n'
    composedeq += '' + '\n'
    composedeq += '  lowshelf:\n';
    composedeq += '    type: Biquad' + '\n';
    composedeq += '    parameters:' + '\n';
    composedeq += '      type: LowshelfFO\n';
    composedeq += '      freq: 120\n';
    composedeq += '      gain: ' + loudnessGain + '\n';
    composedeq += '' + '\n'
    composedeq += '  peakloudness:\n';
    composedeq += '    type: Biquad' + '\n';
    composedeq += '    parameters:' + '\n';
    composedeq += '      type: Peaking\n';
    composedeq += '      freq: 2000\n';
    composedeq += '      q: 0.6\n';
    composedeq += '      gain: ' + ((loudnessGain * -0.061050638902035)).toFixed(2) + '\n';
    composedeq += '' + '\n'
    composedeq += '  peakloudness2:\n';
    composedeq += '    type: Biquad' + '\n';
    composedeq += '    parameters:' + '\n';
    composedeq += '      type: Peaking\n';
    composedeq += '      freq: 4000\n';
    composedeq += '      q: 0.8\n';
    composedeq += '      gain: ' + ((loudnessGain * -0.0274491244675816)).toFixed(2) + '\n';
    composedeq += '' + '\n'
    composedeq += '  peakloudness3:\n';
    composedeq += '    type: Biquad' + '\n';
    composedeq += '    parameters:' + '\n';
    composedeq += '      type: Peaking\n';
    composedeq += '      freq: 8000\n';
    composedeq += '      q: 2.13\n';
    composedeq += '      gain: ' + ((loudnessGain * 0.0709891150023663)).toFixed(2) + '\n';
    composedeq += '' + '\n'

    result += composedeq
    //-----loudness pipeline

    // gainmaxused += loudnessGain
  }
  else {
    loudnessGain = 0
  }

  for (let o = 1; o < (nbreq + 1); o++) {

    typec = subtypex[((o - 1) * 4) + 1];
    resulttype += typec
  }
  if (resulttype.indexOf('None') == -1) {
    //self.logger.info(logPrefix+' resultype dif from None ' + resulttype)
  } else {
    //self.logger.info(logPrefix+' Resultype only None ' + resulttype)
    var composedeq = '';
    composedeq += '  nulleq:' + '\n';
    composedeq += '    type: Conv' + '\n';
    pipeliner = '      - nulleq';
    result += composedeq
    pipelinelr = pipeliner.slice(8)
    pipelinerr = pipeliner.slice(8)

    self.logger.info(logPrefix + ' Nulleq applied')

    gainresult = 0
    gainclipfree = 0
  }


  if (effect == false) {
    var composedeq = '';
    composedeq += '  nulleq:' + '\n';
    composedeq += '    type: Conv' + '\n';

    //self.logger.info(logPrefix + ' Effects disabled')
    gainresult = 0
    gainclipfree = self.config.get('gainapplied')

  } else {

    for (let o = 1; o < (nbreq + 1); o++) {
      eqo = ("eq" + o + "c");
      eqa = subtypex[((o - 1) * 4) + 3]//("eq" + o);
      typec = subtypex[((o - 1) * 4) + 1];
      scoper = subtypex[((o - 1) * 4) + 2]//("scope" + o);
      convatt = subtypex[((o - 1) * 4) + 3]//("scope" + o);

      var composedeq = '';
      var gainmax;
      var pipelineL = '';
      var pipelineR = '';

      typer = typec//self.config.get(typec);
      if (eqa == undefined) {
        self.logger.error(logPrefix + ' Error in eqv! Cannot split values!')
        return;
      }
      eqv = eqa.split(',');
      var coef;
      var eqc = 'eq' + o;

      if (eqv[0] < hcurrentsamplerate / 2) {

        if ((typer == 'Highshelf' || typer == 'Lowshelf')) {

          composedeq += '  ' + eqc + ':\n';
          composedeq += '    type: Biquad' + '\n';
          composedeq += '    parameters:' + '\n';
          composedeq += '      type: ' + typer + '\n';
          composedeq += '      freq: ' + eqv[0] + '\n';
          composedeq += '      slope: ' + eqv[2] + '\n';
          composedeq += '      gain: ' + eqv[1] + '\n';
          composedeq += '' + '\n';
          gainmax = ',' + eqv[1];
          if (scoper == 'L') {
            pipelineL = '      - ' + eqc + '\n';

          } else if (scoper == 'R') {
            pipelineR = '      - ' + eqc + '\n';

          } else if (scoper == 'L+R') {
            pipelineL = '      - ' + eqc + '\n';
            pipelineR = '      - ' + eqc + '\n';
          }
        }
        if ((typer == 'Highshelf2' || typer == 'Lowshelf2')) {

          composedeq += '  ' + eqc + ':\n';
          composedeq += '    type: Biquad' + '\n';
          composedeq += '    parameters:' + '\n';
          composedeq += '      type: ' + typer.slice(0, -1) + '\n';
          composedeq += '      freq: ' + eqv[0] + '\n';
          composedeq += '      q: ' + eqv[2] + '\n';
          composedeq += '      gain: ' + eqv[1] + '\n';
          composedeq += '' + '\n';
          gainmax = ',' + eqv[1];
          if (scoper == 'L') {
            pipelineL = '      - ' + eqc + '\n';

          } else if (scoper == 'R') {
            pipelineR = '      - ' + eqc + '\n';

          } else if (scoper == 'L+R') {
            pipelineL = '      - ' + eqc + '\n';
            pipelineR = '      - ' + eqc + '\n';
          }
        } else if (typer == 'Peaking') {

          composedeq += '  ' + eqc + ':\n';
          composedeq += '    type: Biquad' + '\n';
          composedeq += '    parameters:' + '\n';
          composedeq += '      type: ' + typer + '\n';
          composedeq += '      freq: ' + eqv[0] + '\n';
          composedeq += '      q: ' + eqv[2] + '\n';
          composedeq += '      gain: ' + eqv[1] + '\n';
          composedeq += '' + '\n';
          gainmax = ',' + eqv[1];
          if (scoper == 'L') {
            pipelineL = '      - ' + eqc + '\n';

          } else if (scoper == 'R') {
            pipelineR = '      - ' + eqc + '\n';

          } else if (scoper == 'L+R') {
            pipelineL = '      - ' + eqc + '\n';
            pipelineR = '      - ' + eqc + '\n';
          }

        } else if (typer == 'Peaking2') {

          composedeq += '  ' + eqc + ':\n';
          composedeq += '    type: Biquad' + '\n';
          composedeq += '    parameters:' + '\n';
          composedeq += '      type: ' + typer.slice(0, -1) + '\n';
          composedeq += '      freq: ' + eqv[0] + '\n';
          composedeq += '      bandwidth: ' + eqv[2] + '\n';
          composedeq += '      gain: ' + eqv[1] + '\n';
          composedeq += '' + '\n';
          gainmax = ',' + eqv[1];
          if (scoper == 'L') {
            pipelineL = '      - ' + eqc + '\n';

          } else if (scoper == 'R') {
            pipelineR = '      - ' + eqc + '\n';

          } else if (scoper == 'L+R') {
            pipelineL = '      - ' + eqc + '\n';
            pipelineR = '      - ' + eqc + '\n';
          }

        } else if (typer == 'Conv') {
          var convtype = self.config.get('convtype')
          filterr = eval('filter' + o)

          var composedeq = '';
          composedeq += '  conv' + [o] + ':\n';
          composedeq += '    type: Conv' + '\n';
          composedeq += '    parameters:' + '\n';
          composedeq += '      type: ' + convtype + '\n';
          composedeq += '      filename: ' + filterfolder + filterr + '\n';
          if (convtype != 'Wav') {
            composedeq += '      format: ' + self.config.get("filter_format") + '\n';
          }
          //composedeq += '      ' + skipval + '\n';
          composedeq += '' + '\n';
          gainmax = ',' + convatt

          if (testclipping) {
            gainmax = ',0'
          }

          if (o == 1) {
            pipelineL = '      - conv1\n'
          }
          if (o == 2) {
            pipelineR = '      - conv2\n'
          }

          //result += composedeq

        } else if ((typer == 'Lowpass' || typer == 'Highpass' || typer == 'Notch')) {

          composedeq += '  ' + eqc + ':\n';
          composedeq += '    type: Biquad' + '\n';
          composedeq += '    parameters:' + '\n';
          composedeq += '      type: ' + typer + '\n';
          composedeq += '      freq: ' + eqv[0] + '\n';
          composedeq += '      q: ' + eqv[1] + '\n';
          composedeq += '' + '\n';
          gainmax = ',' + 0
          if (scoper == 'L') {
            pipelineL = '      - ' + eqc + '\n';

          } else if (scoper == 'R') {
            pipelineR = '      - ' + eqc + '\n';

          } else if (scoper == 'L+R') {
            pipelineL = '      - ' + eqc + '\n';
            pipelineR = '      - ' + eqc + '\n';

          }

        } else if ((typer == 'Notch2')) {

          composedeq += '  ' + eqc + ':\n';
          composedeq += '    type: Biquad' + '\n';
          composedeq += '    parameters:' + '\n';
          composedeq += '      type: ' + typer.slice(0, -1) + '\n';
          composedeq += '      freq: ' + eqv[0] + '\n';
          composedeq += '      bandwidth: ' + eqv[1] + '\n';
          composedeq += '' + '\n';
          gainmax = ',' + 0
          if (scoper == 'L') {
            pipelineL = '      - ' + eqc + '\n';

          } else if (scoper == 'R') {
            pipelineR = '      - ' + eqc + '\n';

          } else if (scoper == 'L+R') {
            pipelineL = '      - ' + eqc + '\n';
            pipelineR = '      - ' + eqc + '\n';

          }

        } else if (typer == 'LowshelfFO' || typer == 'HighshelfFO') {

          composedeq += '  ' + eqc + ':\n';
          composedeq += '    type: Biquad' + '\n';
          composedeq += '    parameters:' + '\n';
          composedeq += '      type: ' + typer + '\n';
          composedeq += '      freq: ' + eqv[0] + '\n';
          composedeq += '      gain: ' + eqv[1] + '\n';
          composedeq += '' + '\n';
          gainmax = ',' + eqv[1]
          if (scoper == 'L') {
            pipelineL = '      - ' + eqc + '\n';

          } else if (scoper == 'R') {
            pipelineR = '      - ' + eqc + '\n';

          } else if (scoper == 'L+R') {
            pipelineL = '      - ' + eqc + '\n';
            pipelineR = '      - ' + eqc + '\n';

          }

        } else if ((typer == 'LowpassFO' || typer == 'HighpassFO')) {

          composedeq += '  ' + eqc + ':\n';
          composedeq += '    type: Biquad' + '\n';
          composedeq += '    parameters:' + '\n';
          composedeq += '      type: ' + typer + '\n';
          composedeq += '      freq: ' + eqv[0] + '\n';
          composedeq += '' + '\n';
          gainmax = ',' + 0
          if (scoper == 'L') {
            pipelineL = '      - ' + eqc + '\n';

          } else if (scoper == 'R') {
            pipelineR = '      - ' + eqc + '\n';

          } else if (scoper == 'L+R') {
            pipelineL = '      - ' + eqc + '\n';
            pipelineR = '      - ' + eqc + '\n';

          }
        } else if (typer == 'LinkwitzTransform') {

          composedeq += '  ' + eqc + ':\n';
          composedeq += '    type: Biquad' + '\n';
          composedeq += '    parameters:' + '\n';
          composedeq += '      type: ' + typer + '\n';
          composedeq += '      freq_act: ' + eqv[0] + '\n';
          composedeq += '      q_act: ' + eqv[1] + '\n';
          composedeq += '      freq_target: ' + eqv[2] + '\n';
          composedeq += '      q_target: ' + eqv[3] + '\n';
          composedeq += '' + '\n';
          gainmax = ',' + 0
          if (scoper == 'L') {
            pipelineL = '      - ' + eqc + '\n';

          } else if (scoper == 'R') {
            pipelineR = '      - ' + eqc + '\n';

          } else if (scoper == 'L+R') {
            pipelineL = '      - ' + eqc + '\n';
            pipelineR = '      - ' + eqc + '\n';

          }

        } else if (typer == 'ButterworthHighpass' || typer == 'ButterworthLowpass') {

          composedeq += '  ' + eqc + ':\n';
          composedeq += '    type: BiquadCombo' + '\n';
          composedeq += '    parameters:' + '\n';
          composedeq += '      type: ' + typer + '\n';
          composedeq += '      freq: ' + eqv[0] + '\n';
          composedeq += '      order: ' + eqv[1] + '\n';
          composedeq += '' + '\n';
          gainmax = ',' + 0
          if (scoper == 'L') {
            pipelineL = '      - ' + eqc + '\n';

          } else if (scoper == 'R') {
            pipelineR = '      - ' + eqc + '\n';

          } else if (scoper == 'L+R') {
            pipelineL = '      - ' + eqc + '\n';
            pipelineR = '      - ' + eqc + '\n';

          }

        } else if (typer == 'None') {

          composedeq = ''
          pipelineL = ''
          pipelineR = ''
          gainmax = ',' + 0

        }


        var outlpipeline, outrpipeline;
        result += composedeq
        outlpipeline += pipelineL
        outrpipeline += pipelineR
        pipelinelr = outlpipeline.slice(17)
        pipelinerr = outrpipeline.slice(17)
        if (loudness == false) {

          if (pipelinelr == '') {
            pipelinelr = 'nulleq2'
          }

          if (pipelinerr == '') {
            pipelinerr = 'nulleq2'
          }
        }
        gainmaxused += gainmax
        if (self.config.get('loudness') && effect) {
          pipelinelr += '      - highshelf\n';
          pipelinelr += '      - peakloudness\n';
          pipelinelr += '      - peakloudness2\n';
          pipelinelr += '      - peakloudness3\n';
          pipelinelr += '      - lowshelf\n';
          pipelinerr += '      - highshelf\n';
          pipelinerr += '      - peakloudness\n';
          pipelinerr += '      - peakloudness2\n';
          pipelinerr += '      - peakloudness3\n';
          pipelinerr += '      - lowshelf\n';
        }
        if (delayscope != 'None') {
          if (delayscope == 'L') {
            pipelinelr += '' + '\n';

            pipelinelr += '      - delayG' + '\n';

          } else if (delayscope == 'R') {
            pipelinerr += '' + '\n';
            pipelinerr += '      - delayG' + '\n';

          } else if (delayscope == 'L+R') {
            pipelinelr += '' + '\n';
            pipelinelr += '      - delayG' + '\n';
            pipelinerr += '' + '\n';
            pipelinerr += '      - delayG' + '\n';
          }

        }
      }
    };

  };

  gainmaxused += ',' + loudnessGain

  const withNegativeValues = gainmaxused.split(',').some((val) => val < 0);
  gainresult = (gainmaxused.toString().split(',').slice(1).sort((a, b) => a - b)).pop();

  //    self.logger.info(logPrefix + ' gainmaxused ' + gainmaxused + ' ' + typeof (withNegativeValues) + withNegativeValues)
  let monooutput = self.config.get('monooutput')

  if (effect) {

    if (+gainresult == 0 && !withNegativeValues) {
      gainclipfree = -0.05
    } else if (+gainresult == 0 && withNegativeValues) {
      gainclipfree = -2.5
      self.logger.info(logPrefix + ' else 1  ' + gainclipfree)
    } else if (+gainresult > 0 && (selectedsp != "convfir")) {
      gainclipfree = ('-' + ((parseFloat(Number(gainresult).toFixed(2))) + 2.5))
    } else if (+gainresult > 0 && (selectedsp == "convfir")) {
      gainclipfree = ('-' + (parseFloat(Number(gainresult))))
    }
    if ((gainclipfree === undefined) || ((autoatt == false) && (selectedsp != "convfir"))) {
      gainclipfree = 0
    }
    self.config.set('gainapplied', gainclipfree)

  }
  gainclipfree = self.config.get('gainapplied')
  let leftgain = (+gainclipfree + +leftlevel - +crossatt)
  let rightgain = (+gainclipfree + +rightlevel - +crossatt);
  let leftgainmono = (+gainclipfree + +leftlevel - 6.1)
  let rightgainmono = (+gainclipfree + +rightlevel - 6.1);
  let permutchannel = self.config.get('permutchannel')
  var c0 = "0"
  var c1 = "1"
  if (permutchannel) {
    c0 = "1"
    c1 = "0"
  }

  ///----mixers and pipelines generation
  var composedmixer = ''
  var composedpipeline = ''
  let muteleft = self.config.get('muteleft')
  let muteright = self.config.get('muteright')

  if ((crossconfig == 'None') && (effect)) {
    if (monooutput) {
      composedmixer += 'mixers:\n'
      composedmixer += '  mono:\n'
      composedmixer += '    channels:\n'
      composedmixer += '      in: 2\n'
      composedmixer += '      out: 2\n'
      composedmixer += '    mapping:\n'
      composedmixer += '      - dest: 0\n'
      composedmixer += '        sources:\n'
      composedmixer += '          - channel: 0\n'
      composedmixer += '            gain: ' + +leftgainmono + '\n'
      composedmixer += '            inverted: false\n'
      composedmixer += '            mute: ' + muteleft + '\n'
      composedmixer += '          - channel: 1\n'
      composedmixer += '            gain: ' + +leftgainmono + '\n'
      composedmixer += '            inverted: false\n'
      composedmixer += '            mute: ' + muteright + '\n'
      composedmixer += '      - dest: 1\n'
      composedmixer += '        sources:\n'
      composedmixer += '          - channel: 0\n'
      composedmixer += '            gain: ' + +rightgainmono + '\n'
      composedmixer += '            inverted: false\n'
      composedmixer += '            mute: ' + muteleft + '\n'
      composedmixer += '          - channel: 1\n'
      composedmixer += '            gain: ' + +rightgainmono + '\n'
      composedmixer += '            inverted: false\n'
      composedmixer += '            mute: ' + muteright + '\n'
      composedmixer += '\n'

      composedpipeline += '\n'
      composedpipeline += 'pipeline:\n'
      composedpipeline += '  - type: Mixer\n'
      composedpipeline += '    name: mono\n'
      composedpipeline += '  - type: Filter\n'
      composedpipeline += '    channel: 0\n'
      composedpipeline += '    names:\n'
      composedpipeline += '      - ' + pipelinelr + '\n'
      composedpipeline += '  - type: Filter\n'
      composedpipeline += '    channel: 1\n'
      composedpipeline += '    names:\n'
      composedpipeline += '      - ' + pipelinerr + '\n'
      composedpipeline += '\n'
    } else {
      composedmixer += 'mixers:\n'
      composedmixer += '  stereo:\n'
      composedmixer += '    channels:\n'
      composedmixer += '      in: 2\n'
      composedmixer += '      out: 2\n'
      composedmixer += '    mapping:\n'
      composedmixer += '      - dest: 0\n'
      composedmixer += '        sources:\n'
      composedmixer += '          - channel: ' + c0 + '\n'
      composedmixer += '            gain: ' + leftgain + '\n'
      composedmixer += '            inverted: false\n'
      composedmixer += '            mute: ' + muteleft + '\n'
      composedmixer += '      - dest: 1\n'
      composedmixer += '        sources:\n'
      composedmixer += '          - channel: ' + c1 + '\n'
      composedmixer += '            gain: ' + rightgain + '\n'
      composedmixer += '            inverted: false\n'
      composedmixer += '            mute: ' + muteright + '\n'
      composedmixer += '\n'

      composedpipeline += '\n'
      composedpipeline += 'pipeline:\n'
      composedpipeline += '  - type: Mixer\n'
      composedpipeline += '    name: stereo\n'
      composedpipeline += '  - type: Filter\n'
      composedpipeline += '    channel: 0\n'
      composedpipeline += '    names:\n'
      composedpipeline += '      - ' + pipelinelr + '\n'
      composedpipeline += '  - type: Filter\n'
      composedpipeline += '    channel: 1\n'
      composedpipeline += '    names:\n'
      composedpipeline += '      - ' + pipelinerr + '\n'
      composedpipeline += '\n'
    }

  } else if ((crossconfig != 'None') && (!is_natural) && (effect)) {
    // -- if a crossfeed is used
    composedmixer += 'mixers:\n'
    composedmixer += '  2to4:\n'
    composedmixer += '    channels:\n'
    composedmixer += '      in: 2\n'
    composedmixer += '      out: 4\n'
    composedmixer += '    mapping:\n'
    composedmixer += '      - dest: 0\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: 0\n'
    composedmixer += '            gain: ' + leftgain + '\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: false\n'
    composedmixer += '      - dest: 1\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: 0\n'
    composedmixer += '            gain: ' + leftgain + '\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: false\n'
    composedmixer += '      - dest: 2\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: 1\n'
    composedmixer += '            gain: ' + rightgain + '\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: false\n'
    composedmixer += '      - dest: 3\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: 1\n'
    composedmixer += '            gain: ' + rightgain + '\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: false\n'
    composedmixer += '  stereo:\n'
    composedmixer += '    channels:\n'
    composedmixer += '      in: 4\n'
    composedmixer += '      out: 2\n'
    composedmixer += '    mapping:\n'
    composedmixer += '      - dest: 0\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: ' + c0 + '\n'
    composedmixer += '            gain: 0\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: ' + muteleft + '\n'
    composedmixer += '          - channel: 2\n'
    composedmixer += '            gain: 0\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: ' + muteleft + '\n'
    composedmixer += '      - dest: 1\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: ' + c1 + '\n'
    composedmixer += '            gain: 0\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: ' + muteright + '\n'
    composedmixer += '          - channel: 3\n'
    composedmixer += '            gain: 0\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: ' + muteright + '\n'

    composedpipeline += '\n'
    composedpipeline += 'pipeline:\n'
    composedpipeline += '   - type: Mixer\n'
    composedpipeline += '     name: 2to4\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 0\n'
    composedpipeline += '     names:\n'
    composedpipeline += '       - highcross\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 1\n'
    composedpipeline += '     names:\n'
    composedpipeline += '       - lpcross\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 1\n'
    composedpipeline += '     names:\n'
    composedpipeline += '       - delay\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 2\n'
    composedpipeline += '     names:\n'
    composedpipeline += '       - lpcross\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 2\n'
    composedpipeline += '     names:\n'
    composedpipeline += '       - delay\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 3\n'
    composedpipeline += '     names:\n'
    composedpipeline += '       - highcross\n'
    composedpipeline += '   - type: Mixer\n'
    composedpipeline += '     name: stereo\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 0\n'
    composedpipeline += '     names:\n'
    composedpipeline += '      - ' + pipelinelr + '\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 1\n'
    composedpipeline += '     names:\n'
    composedpipeline += '      - ' + pipelinerr + '\n'


  } else if ((crossconfig != 'None') && (is_natural) && (effect)) {
    // -- if a crossfeed is used
    composedmixer += 'mixers:\n'
    composedmixer += '  2to4:\n'
    composedmixer += '    channels:\n'
    composedmixer += '      in: 2\n'
    composedmixer += '      out: 4\n'
    composedmixer += '    mapping:\n'
    composedmixer += '      - dest: 0\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: 0\n'
    composedmixer += '            gain: ' + leftgain + '\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: false\n'
    composedmixer += '      - dest: 1\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: 0\n'
    composedmixer += '            gain: ' + leftgain + '\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: false\n'
    composedmixer += '      - dest: 2\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: 1\n'
    composedmixer += '            gain: ' + rightgain + '\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: false\n'
    composedmixer += '      - dest: 3\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: 1\n'
    composedmixer += '            gain: ' + rightgain + '\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: false\n'
    composedmixer += '  stereo:\n'
    composedmixer += '    channels:\n'
    composedmixer += '      in: 4\n'
    composedmixer += '      out: 2\n'
    composedmixer += '    mapping:\n'
    composedmixer += '      - dest: 0\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: ' + c0 + '\n'
    composedmixer += '            gain: 0\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: ' + muteleft + '\n'
    composedmixer += '          - channel: 2\n'
    composedmixer += '            gain: 0\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: ' + muteleft + '\n'
    composedmixer += '      - dest: 1\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: ' + c1 + '\n'
    composedmixer += '            gain: 0\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: ' + muteright + '\n'
    composedmixer += '          - channel: 3\n'
    composedmixer += '            gain: 0\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: ' + muteright + '\n'

    composedpipeline += '\n'
    composedpipeline += 'pipeline:\n'
    composedpipeline += '   - type: Mixer\n'
    composedpipeline += '     name: 2to4\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 0\n'
    composedpipeline += '     names:\n'
    composedpipeline += '       - hrtf_conv_ll\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 1\n'
    composedpipeline += '     names:\n'
    composedpipeline += '       - hrtf_conv_lr\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 2\n'
    composedpipeline += '     names:\n'
    composedpipeline += '       - hrtf_conv_rl\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 3\n'
    composedpipeline += '     names:\n'
    composedpipeline += '       - hrtf_conv_rr\n'
    composedpipeline += '   - type: Mixer\n'
    composedpipeline += '     name: stereo\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 0\n'
    composedpipeline += '     names:\n'
    composedpipeline += '      - ' + pipelinelr + '\n'
    composedpipeline += '   - type: Filter\n'
    composedpipeline += '     channel: 1\n'
    composedpipeline += '     names:\n'
    composedpipeline += '      - ' + pipelinerr + '\n'


  } else if (effect == false) {

    self.logger.info(logPrefix + ' Effects disabled')
    gainresult = 0
    //   gainclipfree = self.config.get('gainapplied')

    composedmixer += 'mixers:\n'
    composedmixer += '  stereo:\n'
    composedmixer += '    channels:\n'
    composedmixer += '      in: 2\n'
    composedmixer += '      out: 2\n'
    composedmixer += '    mapping:\n'
    composedmixer += '      - dest: 0\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: ' + c0 + '\n'
    composedmixer += '            gain: ' + leftgain + '\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: false\n'
    composedmixer += '      - dest: 1\n'
    composedmixer += '        sources:\n'
    composedmixer += '          - channel: ' + c1 + '\n'
    composedmixer += '            gain: ' + rightgain + '\n'
    composedmixer += '            inverted: false\n'
    composedmixer += '            mute: false'
    composedmixer += '\n'

    pipeliner = '      - nulleq2';
    pipelinelr = pipeliner.slice(8)
    pipelinerr = pipeliner.slice(8)

    composedpipeline += '\n'
    composedpipeline += 'pipeline:\n'
    composedpipeline += '  - type: Mixer\n'
    composedpipeline += '    name: stereo\n'
    /*    composedpipeline += '  - type: Filter\n'
        composedpipeline += '    channel: 0\n'
        composedpipeline += '    names:\n'
        composedpipeline += '      - ' + pipelinelr + '\n'
        composedpipeline += '  - type: Filter\n'
        composedpipeline += '    channel: 1\n'
        composedpipeline += '    names:\n'
        composedpipeline += '      - ' + pipelinerr + '\n'
        //   composedpipeline += '\n'
      */
  }

  let data = fs.readFileSync(__dirname + "/camilladsp.conf.yml", 'utf8');

  let strConfig = data.replace("${resulteq}", result)
    .replace("${chunksize}", (chunksize))
    .replace("${resampling}", (composeddevice))
    .replace("${outputsamplerate}", (outputsamplerate))

    .replace("${composeout}", (composeout))
    .replace("${mixers}", composedmixer)
    .replace("${composedpipeline}", composedpipeline.replace(/-       - /g, '- '))
    //  .replace("${pipelineR}", pipelinerr)
    ;

  self.logger.debug(logPrefix + result);

  return strConfig;

}

let getCamillaPureGuiConfig = function (plugin, chunksize, samplerate) {

  let strConfig;

  try {

    /*
     * Read the existing camilladsp.yml configuration file and replace chunksize and capture samplerate.
     * If capture samplerate is not present in the configuration file (for example, due to an upgrade
     * of the plugin from a previous version), then append it after "samplerate" to make it compliant.
     *
     * If a camilladsp.yml file does not exist, handle the exception and use a vanilla configuration
     * from the template file.
     */

    let regexChunksize = /(chunksize): \d+/;
    let regexCapturesamplerate = /(capture_samplerate): \d+/;
    let regexSamplerate = /(\s+)(samplerate)(: \d+)/;
    let regexIsResamplingEnabled = /enable_resampling: true/;

    strConfig = fs.readFileSync("/data/configuration/audio_interface/fusiondsp/camilladsp.yml", "utf-8");

    // If resampling is active, don't alter the "samplerate" parameter
    // otherwise make it equal as "capture_samplerate" parameter
    let isResamplingActive = strConfig.search(regexIsResamplingEnabled) !== -1;

    if (isResamplingActive === false)
      strConfig = strConfig.replace(regexSamplerate, `$1$2: ${samplerate}`);

    // Modify chunksize and capture_samplerate parameters with those coming from stream
    strConfig = strConfig
      .replace(regexCapturesamplerate, `$1: ${samplerate}`)
      .replace(regexChunksize, `$1: ${chunksize}`);

    // In case capture_samplerate is not present, add it right after samplerate
    if (strConfig.search(regexCapturesamplerate) === -1)
      strConfig = strConfig.replace(regexSamplerate, `$1$2$3capture_samplerate: ${samplerate}`);

  } catch (err) {

    plugin.logging.warning("camilladsp.yml configuration does not exist, providing bare default from camilladsp-pure.conf.yml");
    strConfig = fs.readFileSync(__dirname + "/camilladsp-pure.conf.yml", 'utf8');

    strConfig = strConfig.replace("${chunksize}", chunksize)
      .replace("${outputsamplerate}", samplerate)
      .replace("${capturesamplerate}", samplerate);

  }

  return strConfig;

}

//------------Here we build CmaillaDsp config file----------------------------------------------

FusionDsp.prototype.createCamilladspfile = function (callback) {
  const self = this;
  let defer = libQ.defer();
  var hcurrentsamplerate = 44100;
  let hformat = "S32_LE";
  let hchannels = 2;
  let hbitdepth = 32;
  let selectedsp = self.config.get('selectedsp')
  let chunksize = 4800;
  let strCamillaConf;

  /*
   * Read the sampling rate, format, channels and bitdepth from ALSA provided
   * hook, then check if we received sample rate from pushstate and prefer the
   * latter in case
   */
  if (self.pushstateSamplerate)
    hcurrentsamplerate = self.pushstateSamplerate;

  if (selectedsp != 'convfir')
    self.logger.info(logPrefix + ' If filter freq >samplerate/2 then disable it');

  try {

    if (selectedsp === "purecgui") {

      strCamillaConf = getCamillaPureGuiConfig(self, chunksize, hcurrentsamplerate);

    } else {

      strCamillaConf = getCamillaFiltersConfig(self, selectedsp, chunksize, hcurrentsamplerate);

    }

    fs.writeFileSync("/data/configuration/audio_interface/fusiondsp/camilladsp.yml", strCamillaConf, 'utf8');

    if (callback)
      callback();
    else
      self.sendCommandToCamilla();

  } catch (err) {

    self.logger.error(err);

  }

  return defer.promise;
};

//----------------------here we save eqs config.json
FusionDsp.prototype.saveparameq = function (data, obj) {
  const self = this;
  let defer = libQ.defer();
  let test = '';
  let selectedsp = self.config.get('selectedsp')


  if (selectedsp == 'PEQ') {
    var nbreq = self.config.get('nbreq')
    for (var o = 1; o < (nbreq + 1); o++) {
      var typec = 'type' + o;
      var scopec = 'scope' + o;
      var eqc = 'eq' + o;
      var typer = (data[typec].value)
      var eqr = (data[eqc]).split(',')
      var veq = Number(eqr[0]);

      if (typer !== 'None' && typer !== 'Remove') {
        //  self.logger.info(logPrefix + ' Type is ' + typer)

        if (Number.parseFloat(veq) && (veq > 0 && veq < 22050)) {
          //  self.logger.info(logPrefix+' value ok ')

        } else {

          self.logger.error(logPrefix + ' wrong value in ' + eqc)
          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('FREQUENCY_RANGE') + eqc)
          return;
        }
      }
      if (typer == 'Peaking' || typer == 'Highshelf2' || typer == 'Lowshelf2') {

        var q = Number(eqr[2]);
        if ((Number.parseFloat(q)) && (q > 0 && q < 40.1)) {

        } else {
          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('Q_RANGE') + eqc)
          return;
        }

      }

      if (typer == 'Peaking2') {

        var q = Number(eqr[2]);
        if ((Number.parseFloat(q)) && (q > 0 && q < 8)) {

        } else {
          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('BANDWIDTH_RANGE') + eqc)
          return;
        }

      }

      if (typer == 'Highpass' || typer == 'Lowpass' || typer == 'Notch') {

        var q = Number(eqr[1]);
        if ((Number.parseFloat(q)) && (q > 0 && q < 40.1)) {

        } else {
          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('Q_RANGE') + eqc)
          return;
        }

      }
      if (typer == 'LinkwitzTransform') {

        var qa = Number(eqr[1])
        var qt = Number(eqr[3])
        if ((Number.parseFloat(qa)) && (qa > 0 && qa < 40.1) && (Number.parseFloat(qt)) && (qt > 0 && qt < 40.1)) {

        } else {
          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('Q_RANGE') + eqc)
          return;
        }
        var ft = Number(eqr[2]);
        if (Number.parseFloat(veq) && (veq > 0 && veq < 22050)) {

        } else {
          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('FREQUENCY_RANGE') + eqc)
          return;
        }

      }

      if (typer == 'ButterworthHighpass' || typer == 'ButterworthLowpass') {
        var order = Number(eqr[1]);
        var arr = [2, 4, 6, 8];
        if (arr.indexOf(order) > -1) {
        } else {
          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('BIQUAD_COMBO_ORDER') + eqc)
          return;

        }

      }

      if (typer == 'Highpass2' || typer == 'Lowpass2' || typer == 'Notch2') {

        var q = Number(eqr[1]);
        if ((Number.parseFloat(q)) && (q > 0 && q < 25.1)) {

        } else {
          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('BANDWIDTH_RANGE') + eqc)
          return;
        }

      }
      if (typer == 'Peaking' || typer == 'Highshelf' || typer == 'Lowshelf' || typer == 'LowshelfFO' || typer == 'HighshelfFO') {

        var g = Number(eqr[1]);
        if ((Number.parseFloat(g)) && (g > -20.1 && g < 20.1)) {

        } else {
          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('GAIN_RANGE') + eqc)
          return;
        }

      }
      if (typer == 'Highshelf' || typer == 'Lowshelf') {

        var s = Number(eqr[2]);
        if ((Number.parseFloat(s)) && (s > 0 && s < 13)) {

        } else {
          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('SLOPE_RANGE') + eqc)
          return;
        }
      }

      if (typer == 'Highpass' || typer == 'Lowpass' || typer == 'Notch' || typer == 'Highpass2' || typer == 'Lowpass2' || typer == 'Notch2' || typer == 'ButterworthHighpass' || typer == 'ButterworthLowpass' || typer == 'LowshelfFO' || typer == 'HighshelfFO') {

        var q = eqr[2];
        if (q != undefined) {
          self.logger.info(logPrefix + ' last value ' + q)

          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('NO_THIRDCOEFF') + eqc)
          return;
        } else {
          //do nthing
        }
      }

      if (typer == 'HighpassFO' || typer == 'LowpassFO') {

        var q = eqr[1];
        self.logger.info(logPrefix + ' last value ' + q)
        if (q != undefined) {
          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('ONLY_FREQ') + eqc)
          return;
        } else {
          //do nthing
        }
      } else {
        // self.logger.info(logPrefix + ' nothing todo');
      }
    }

    let skipeqn = 0;
    for (var xo = 1; xo < (nbreq + 1); xo++) {
      var o = xo
      var typec = 'type' + o;
      var scopec = 'scope' + o;
      var eqc = 'eq' + o;
      //--- skip PEQ if set to REMOVE
      if (((data[typec].value) != 'Remove')) {
        test += ('Eq' + o + '|' + data[typec].value + '|' + data[scopec].value + '|' + data[eqc] + '|');
        //  self.logger.info(logPrefix + ' test values ' + test)
        //  self.commandRouter.pushToastMessage('info', self.commandRouter.getI18nString('VALUE_SAVED_APPLIED'))
      } else if (((data[typec].value) == 'Remove') && (nbreq == 1)) {
        self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('CANT_REMOVE_LAST_PEQ'))
      } else if (((data[typec].value) == 'Remove') && (nbreq != 1)) {
        skipeqn = skipeqn + 1
        self.logger.info(logPrefix + ' skipeqn ' + skipeqn)

      }
    }
    self.config.set('nbreq', nbreq - skipeqn)
    self.config.set('savednbreq', nbreq - skipeqn)
    self.config.set('savedmergedeq', test)

  } else if (selectedsp == 'EQ3') {
    let geq3 = (data['geq3'])
    self.config.set('geq3', geq3);

    eqr = geq3
    //self.logger.info(logPrefix + ' setting EQ3 values ' + eqr)
    for (let o in eqr) {
      // for(let q in coefQ3){
      //   let qa =coefQ3[q]
      // let ceq3type = eq3type[o]

      let eqval = geq3[o]
      test += ('Eq' + o + '|' + eq3type[o] + '|L+R|' + eq3range[o] + ',' + eqval + ',' + coefQ3[o] + '|');
      // }
    }
    self.config.set('savedmergedgeqx3', test)
    self.config.set('savedgeq3', self.config.get('geq3'))

  } else if (selectedsp == 'EQ15') {
    let geq15 = (data['geq15'])
    self.config.set('geq15', geq15);
    self.config.set('x2geq15', geq15);

    eqr = geq15
    //self.logger.info(logPrefix + ' setting EQ15 values ' + eqr)
    for (let o in eqr) {
      let eqval = geq15[o]
      test += ('Eq' + o + '|Peaking|L+R|' + eq15range[o] + ',' + eqval + ',' + coefQ[o] + '|');
    }
    self.config.set('savedmergedgeq15', test)
    self.config.set('savedgeq15', self.config.get('geq15'))

  } else if (selectedsp == '2XEQ15') {
    let geq15 = (data['geq15'])
    let x2geq15 = (data['x2geq15'])
    let ltest, rtest
    self.config.set('geq15', geq15);
    self.config.set('x2geq15', x2geq15);
    for (let o in geq15) {
      var eqval = geq15[o]
      ltest += ('Eq' + o + '|Peaking|L|' + eq15range[o] + ',' + eqval + ',' + coefQ[o] + '|');
    }
    for (let v in x2geq15) {
      var eqval = x2geq15[v]
      rtest += ('Eq' + v + '|Peaking|R|' + eq15range[v] + ',' + eqval + ',' + coefQ[v] + '|');
    }
    test = ltest + rtest
    self.config.set('savedmergedeqx2geq15', test)
    self.config.set('savedx2geq15l', self.config.get('geq15'))
    self.config.set('savedx2geq15r', self.config.get('x2geq15'))

  } else if (selectedsp == 'convfir') {
    let attenuationl = (data['attenuationl'].value);
    let attenuationr = (data['attenuationr'].value);
    let leftfilter = (data['leftfilter'].value);
    let rightfilter = (data['rightfilter'].value);

    //    self.checkconvexist()

    if (leftfilter != "None" || rightfilter != "None") {
      //we check if the file for filter still exists
      try {
        const leftFilterPath = path.join(filterfolder, leftfilter);
        const rightFilterPath = path.join(filterfolder, rightfilter);

        const leftFilterExists = fs.existsSync(leftFilterPath);
        const rightFilterExists = fs.existsSync(rightFilterPath);
        //   return new Promise((resolve, reject) => {
        if (leftFilterExists && rightFilterExists) {
          self.logger.info(logPrefix + ' Ok! Convolution files exist');

        } else {
          self.logger.error(logPrefix + 'Nok! Convolution files missing');
          self.commandRouter.pushToastMessage('error', "One filter file is missing!, please reselect it! ");
          self.config.set("leftfilter", "None")
          // self.config.set("leftfilterlabel", "None")
          self.config.set("rightfilter", "None")
          self.config.set("filter_format", "TEXT")
          self.config.set('attenuationl', 0);
          self.config.set('attenuationr', 0);
          self.config.set("savedmergedeqfir", "Eq1|None|L/data/INTERNAL/FusionDsp/filters/None|0|Eq2|None|R/data/INTERNAL/FusionDsp/filters/None|0|");
          self.config.set("mergedeq", "Eq1|None|L/data/INTERNAL/FusionDsp/filters/None|0|Eq2|None|R/data/INTERNAL/FusionDsp/filters/None|0|");
          setTimeout(function () {
            self.createCamilladspfile()
          }, 100);
          self.logger.error(logPrefix + ' __________________STOP NOW__');
          self.refreshUI();
          return [false, null];
        }
      } catch (e) {
        self.logger.error(logPrefix + e);
      }
    }


    let filtername //= self.config.get('leftfilterlabel');
    let filext = (data['leftfilter'].value).split('.').pop().toString();

    if ((leftfilter.split('.').pop().toString()) != (rightfilter.split('.').pop().toString())) {

      self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('DIFF_FILTER_TYPE_MESS'));
      self.logger.error(logPrefix + ' All filter must be of the same type')
      return;
    }

    if (((data['leftfilter'].value).includes(' ')) || ((data['rightfilter'].value).includes(' '))) {
      self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('WARN_SPACE_INFILTER'));
      self.logger.error(logPrefix + ' SPACE NOT ALLOWED in file name')
      return;

    } else {

      self.dfiltertype(data);

      let val = self.dfiltertype(obj);
      let valfound = val.valfound
      self.config.set('leftfilterlabel', leftfilter);
      self.config.set('leftfilter', leftfilter);
      self.config.set('rightfilter', rightfilter);
      let enableclipdetect = data['enableclipdetect'];
      self.config.set('attenuationl', attenuationl);
      self.config.set('attenuationr', attenuationr);
      self.config.set('enableclipdetect', enableclipdetect);
      if (enableclipdetect && ((rightfilter != 'None') || (leftfilter != 'None'))) {

        self.testclipping()

      }
      setTimeout(function () {

        self.areSampleswitch();
      }, 1500);

      let ltest, rtest, cleftfilter, crightfilter

      cleftfilter = filterfolder + leftfilter
      crightfilter = filterfolder + rightfilter
      let typerl = 'Conv'
      let typerr = 'Conv'
      if (leftfilter == 'None') {
        typerl = 'None'
        attenuationl = 0
        self.config.set('attenuationl', attenuationl);
      }
      if (rightfilter == 'None') {
        typerr = 'None'
        attenuationr = 0
        self.config.set('attenuationr', attenuationr);
      }
      ltest = ('Eq1' + '|' + typerl + '|L' + cleftfilter + '|' + attenuationl + '|');
      rtest = ('Eq2' + '|' + typerr + '|R' + crightfilter + '|' + attenuationr + '|');
      test = ltest + rtest
      self.logger.info(logPrefix + ' Test ' + test)

      self.config.set('savedmergedeqfir', test)

    }
  }


  if (self.config.get('moresettings')) {
    let delaymode = self.config.get('manualdelay')

    if (delaymode == true) {

      var value = data['delay']
      if ((Number.parseFloat(value)) && (value >= 0 && value < 1000)) {
        self.config.set('delay', data["delay"]);
        self.config.set('delayscope', (data["delayscope"].value));

        self.logger.info(logPrefix + ' value delay ------- ' + value + ' scope ' + (data['delayscope'].value))
        self.autocaldistancedelay()
      } else {
        self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('DELAY_ERROR'))

        return;
      }
    }

    if (delaymode == false) {
      var valuel = data['ldistance']
      var valuer = data['rdistance']

      if ((valuel >= 0 && valuel < 2500) && (valuer >= 0 && valuer < 2500)) {

        self.config.set('ldistance', valuel);
        self.config.set('rdistance', valuer);
        self.logger.info(logPrefix + ' value distance L------- ' + valuel + ' R ' + valuer);
        self.autocalculdelay()
      } else {
        self.commandRouter.pushToastMessage('error', 'DELAY_ERROR')
        return;
      }
    }

    let monooutput = data["monooutput"]
    if (monooutput) {
      self.config.set('crossfeed', 'None');
    } else {
      self.config.set('crossfeed', data['crossfeed'].value)
    }
    let loudness = data["loudness"]
    if (loudness) {
      self.config.set('loudnessthreshold', data.loudnessthreshold)
      self.socket.emit('volume', '+')
      setTimeout(function () {

        self.sendvolumelevel()
      }, 900);

      self.socket.emit('volume', '-')
    } else {
      //self.socket.off()
    }
    if (selectedsp === 'PEQ' || selectedsp === 'EQ15' || selectedsp === '2XEQ15') {
      let llevel = data.leftlevel
      let rlevel = data.rightlevel

      if ((Number.parseFloat(llevel) <= 0 && Number.parseFloat(llevel) > -20) && (Number.parseFloat(rlevel) <= 0 && Number.parseFloat(rlevel) > -20)) {
        //  self.logger.info(logPrefix + ' value ok ' + llevel + rlevel);
      }
      else {
        self.logger.error(logPrefix + ' wrong value in  level ' + llevel + ' or ' + rlevel)
        self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('ATT_VALUE_WARN'));
        return;
      }
    }
    self.config.set('leftlevel', data.leftlevel);
    self.config.set('rightlevel', data.rightlevel);
    self.config.set('monooutput', data["monooutput"]);
    self.config.set('autoatt', data["autoatt"]);
    self.config.set('muteleft', data["muteleft"]);
    self.config.set('muteright', data["muteright"]);
    if (self.config.get('showloudness')) {
      self.config.set('loudness', loudness);
    }
  }
  self.config.set('permutchannel', data["permutchannel"]);

  self.config.set('effect', true);
  self.config.set('showeq', data["showeq"]);
  self.config.set(selectedsp + "preset", 'no preset used')//preset);
  self.config.set('mergedeq', test);
  self.config.set('importeq', self.commandRouter.getI18nString('CHOOSE_HEADPHONE'));
  self.commandRouter.pushToastMessage('info', self.commandRouter.getI18nString('VALUE_SAVED_APPLIED'))

  setTimeout(function () {
    self.refreshUI();
    self.createCamilladspfile()
  }, 800);
  return defer.promise;
};


FusionDsp.prototype.saveequalizerpreset = function (data) {
  const self = this;
  const dynamicKey = data['renpreset'];
  let selectedsp = self.config.get('selectedsp');
  const fileName = `${dynamicKey}.json`;
  const filePath = `${presetFolder}${selectedsp}/${fileName}`;

  // Check if the file already exists
  if (fs.existsSync(filePath)) {
    var responseData = {
      title: `A file ${dynamicKey} already exists!`,//self.commandRouter.getI18nString('SAMPLE_WARNING_TITLE'),
      message: "Overwrite this file?",//self.commandRouter.getI18nString('SAMPLE_WARNING_MESS'),
      size: 'lg',
      buttons: [
        {
          name: "Ok",//self.commandRouter.getI18nString('GET_IT'),
          class: 'btn btn-cancel',
          emit: 'callMethod',
          payload: { 'endpoint': 'audio_interface/fusiondsp', 'method': 'saveequalizerpresetv' }
        },
        {
          name: "No",
          class: 'btn btn-info',
          emit: 'closeModals',
          payload: ""
        }
      ]
    }
    self.commandRouter.broadcastMessage("openModal", responseData);
    self.logger.warn(logPrefix + `File "${filePath}" already exists. Overwriting...`);
    self.config.set("renpreset", dynamicKey)

  } else {
    self.config.set("renpreset", dynamicKey)
    self.saveequalizerpresetv();
  }
};

FusionDsp.prototype.saveequalizerpresetv = function (data) {
  const self = this;
  let defer = libQ.defer();
  let selectedsp = self.config.get('selectedsp');
  let parameters;
  let state4preset = [
    self.config.get('crossfeed'),
    self.config.get('monooutput'),
    self.config.get('loudness'),
    self.config.get('loudnessthreshold'),
    self.config.get('leftlevel'),
    self.config.get('rightlevel'),
    self.config.get('delay'),
    self.config.get('delayscope'),
    self.config.get('autoatt'),
    self.config.get('muteleft'),
    self.config.get('muteright'),
    self.config.get('ldistance'),
    self.config.get('rdistance'),
    self.config.get('permutchannel')
  ];

  var nbreq = self.config.get('nbreq');

  if (selectedsp == 'PEQ') {
    parameters = {
      spreset: nbreq,
      mergedeq: self.config.get('mergedeq'),
      state4preset: state4preset
    };
  } else if (selectedsp == 'EQ15') {
    parameters = {
      geq15: self.config.get('geq15'),
      x2geq15: self.config.get('geq15'),
      state4preset: state4preset
    };
  } else if (selectedsp == '2XEQ15') {
    parameters = {
      geq15: self.config.get('geq15'),
      x2geq15: self.config.get('x2geq15'),
      state4preset: state4preset
    };
  } else if (selectedsp == 'convfir') {
    parameters = {
      leftfilter: self.config.get('leftfilter'),
      attenuationl: self.config.get('attenuationl'),
      attenuationr: self.config.get('attenuationr'),
      rightfilter: self.config.get('rightfilter'),
      leftfilterlabel: self.config.get('leftfilterlabel'),
      filter_format: self.config.get('filter_format'),
      mergedeq: self.config.get('mergedeq'),
      state4preset: state4preset
    };
  }

  const dynamicKey = self.config.get('renpreset');
  const fileContent = JSON.stringify({ "parameters": parameters }, null, 2);
  const fileName = `${dynamicKey}.json`;
  const filePath = `${presetFolder}${selectedsp}/${fileName}`;

  // Write the file
  fs.writeFile(filePath, fileContent, 'utf8', (err) => {
    if (err) {
      self.logger.error(logPrefix + "Error writing file:", err);
      defer.reject(err);
      return;
    }
    self.logger.info(logPrefix + `File "${filePath}" created successfully.`);
    self.commandRouter.pushToastMessage('success', `Preset ${dynamicKey} saved successfully`);
    self.config.set("renpreset", "");

    setTimeout(() => {
      self.refreshUI();
    }, 500);
    defer.resolve(); // Resolve the promise on success
  });

  return defer.promise;
};

FusionDsp.prototype.usethispreset = function (data) {
  const self = this;
  let defer = libQ.defer();

  let test = ''
  let geq15, x2geq15
  let preset = (data['usethispreset'].value);

  let selectedsp = self.config.get('selectedsp')
  let usedpreset = presetFolder + selectedsp + "/" + preset

  function readValueFromJsonFile(filePath, key, callback) {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        return callback(err);
      }
      let jsonData;
      try {
        jsonData = JSON.parse(data);
      } catch (parseError) {
        return callback(parseError);
      }
      callback(null, jsonData[key]);
    });
  }
  self.logger.info(logPrefix + "Value for usedpreset: ", usedpreset);

  let presetforkey = "parameters";

  readValueFromJsonFile(usedpreset, presetforkey, (err, value) => {
    if (err) {
      self.logger.error(logPrefix + "Error reading JSON file:", err);
    }// else {
    try {
      self.logger.error(logPrefix + "Value reading JSON file:", value);

      const eqrx = value.geq15;
      const x2eqrx = value.x2geq15;
      const state4presetx = value.state4preset;

      if (selectedsp == 'EQ15') {

        geq15 = eqrx.split(',')
        self.logger.info(logPrefix + ' geq15 ' + geq15)

        let o = 1
        var eqr = geq15
        for (o in eqr) {
          let eqval = geq15[o]
          test += ('Eq' + o + '|Peaking|L+R|' + eq15range[o] + ',' + eqval + ',' + coefQ[o] + '|');
        }
        self.config.set('mergedeq', test);
        self.config.set("nbreq", 15);

      } else if (selectedsp == '2XEQ15') {
        geq15 = eqrx.split(',')
        x2geq15 = x2eqrx.split(',')

        self.logger.info(logPrefix + ' geq15 ' + geq15)
        let ltest, rtest
        let o = 1
        var eqr = geq15
        for (let o in geq15) {
          var eqval = geq15[o]
          ltest += ('Eq' + o + '|Peaking|L|' + eq15range[o] + ',' + eqval + ',' + coefQ[o] + '|');
        }
        for (let o in x2geq15) {
          var eqval = x2geq15[o]
          rtest += ('Eq' + o + '|Peaking|R|' + eq15range[o] + ',' + eqval + ',' + coefQ[o] + '|');
        }
        test = ltest + rtest

        self.config.set('mergedeq', test);
        self.config.set("nbreq", 30);

      }

      if ((selectedsp == 'EQ15') || (selectedsp == '2XEQ15')) {
        self.config.set('geq15', eqrx)
        self.config.set('x2geq15', x2eqrx);

      } else if (selectedsp == 'PEQ') {
        var nbreqc = value.spreset;
        self.config.set("nbreq", nbreqc);
        self.config.set('mergedeq', value.mergedeq);

      } else if (selectedsp == 'convfir') {
        self.config.set("usethispreset", preset);
        self.config.set("leftfilter", value.leftfilter);
        self.config.set("rightfilter", value.rightfilter);
        self.config.set('leftfilterlabel', value.leftfilterlabel);
        self.config.set('filter_format', value.filter_format)
        self.config.set('mergedeq', value.savedmergedeqfir)
        self.config.set("attenuationl", value.attenuationl);
        self.config.set("attenuationr", value.attenuationr);
      }

      let state4preset = state4presetx;

      self.logger.info(logPrefix + ' value state4preset ' + state4preset)
      self.config.set('crossfeed', state4preset[0])
      self.config.set('monooutput', state4preset[1])
      self.config.set('loudness', state4preset[2])
      self.config.set('loudnessthreshold', state4preset[3])
      self.config.set('leftlevel', state4preset[4])
      self.config.set('rightlevel', state4preset[5])
      self.config.set('delay', state4preset[6])
      self.config.set('delayscope', state4preset[7])
      self.config.set('autoatt', state4preset[8])
      self.config.set('muteleft', state4preset[9]);
      self.config.set('muteright', state4preset[10]);

      if (selectedsp + state4preset[11] == undefined) {
        self.config.set('ldistance', 0);
      } else {
        self.config.set('ldistance', state4preset[11]);
      }
      if (selectedsp + state4preset[12] == undefined) {
        self.config.set('rdistance', 0);
      } else {
        self.config.set('rdistance', state4preset[12]);
      }
      self.config.set('permutchannel', state4preset[13]);
      self.config.set(selectedsp + "preset", preset);
      self.commandRouter.pushToastMessage('info', presetforkey.replace(/^\./, "") + self.commandRouter.getI18nString('PRESET_LOADED_USED'))

    } catch (e) {
      self.logger.error(logPrefix + ' failed processing JSON value: ' + e);
    }
  });

  setTimeout(function () {
    self.refreshUI();
    self.createCamilladspfile()
  }, 500);
  return defer.promise;
};

FusionDsp.prototype.importeq = function (data) {
  const self = this;
  const path = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results';
  const defer = libQ.defer();
  const nameh = data['importeq'].label;
  const name = nameh.split('  ').slice(1).toString();
  const namepath = data['importeq'].value;
  const suffix = "%20ParametricEQ.txt";
  self.logger.info(logPrefix + ' namepath ' + namepath + ' name ' + name);

  self.config.set('addreplace', true);
  self.config.set('nbreq', 1);
  const toDownload = `${path}${namepath}/${encodeURIComponent(name)}${suffix}`;
  self.logger.info(logPrefix + ' wget \'' + toDownload);

  try {
    execSync(`/usr/bin/wget '${toDownload}' -O /tmp/EQfile.txt`, {
      uid: 1000,
      gid: 1000
    });
    defer.resolve();
  } catch (err) {
    self.logger.error(logPrefix + ' failed to download Eq' + err);
    self.commandRouter.pushToastMessage('error', 'Failed to download EQ: ' + err);
  }

  self.config.set('eqfrom', 'autoeq');
  self.config.set('importeq', nameh);

  self.convertimportedeq();
  return defer.promise;

};

FusionDsp.prototype.importlocal = function (data) {
  const self = this;
  let defer = libQ.defer();
  let file = data['importlocal'].value;
  let localscope;
  if ((file == '') || (file == 'select a file')) {
    self.commandRouter.pushToastMessage('error', 'Choose a file')
    return;
  }
  if (file.includes(' ')) {
    self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('WARN_SPACE_INFILTER'));
    self.logger.error(logPrefix + " File name can't contains a space!")
    return;
  }
  self.config.set('eqfrom', data['importlocal'].value);
  self.config.set('localscope', data['localscope'].value);
  self.config.set('addreplace', data['addreplace']);
  self.convertimportedeq();
  return defer.promise;
};

//----------------here we convert imported file
FusionDsp.prototype.convertimportedeq = function () {
  const self = this;
  let defer = libQ.defer();
  var filepath;
  let localscope;
  var EQfile;
  let test;

  var EQfilef = self.config.get('eqfrom')
  var addreplace = self.config.get('addreplace');
  if (EQfilef == 'autoeq') {
    filepath = ('/tmp/EQfile.txt');
  } else {
    filepath = ('/data/INTERNAL/FusionDsp/peq/' + EQfilef);
  }
  try {
    EQfile = fs.readFileSync(filepath, "utf8");
    //let nbreq = 1;
    if (EQfilef == 'autoeq') {
      // EQfile = EQfile.replace(/LS/g, "LSQ")
      // EQfile = EQfile.replace(/HS/g, "HSQ")
      var EQfile = EQfile
        .replace(/LSC/g, "LSQ")
        .replace(/HSC/g, "HSQ")
    }
    var o = 0;
    if (addreplace) {

      var nbreq = 1;
    } else {
      test = self.config.get('mergedeq')
      var nbreq = self.config.get('nbreq') + 1;
    }
    //var EQfileR = EQfile.replace(/S /g, 'S')
    var result = (EQfile.split('\n'));
    // self.logger.info(result)

    for (o; o < result.length; o++) {
      if (nbreq < tnbreq) {
        if ((result[o].indexOf("Filter") != -1) && (result[o].indexOf("None") == -1) && ((result[o].indexOf("PK") != -1) || (result[o].indexOf("LPQ") != -1) || (result[o].indexOf("HPQ") != -1) || (result[o].indexOf("LP1") != -1) || (result[o].indexOf("HP1") != -1) || (result[o].indexOf("LS ") != -1) || (result[o].indexOf("HS ") != -1) || (result[o].indexOf("NO") != -1) || (result[o].indexOf("LP ") != -1) || (result[o].indexOf("HP ") != -1) || (result[o].indexOf("LS 6dB") != -1) || (result[o].indexOf("HS 6dB") != -1) || (result[o].indexOf("LS 12dB") != -1) || (result[o].indexOf("HS 12dB") != -1) || (result[o].indexOf("LSQ") != -1) || (result[o].indexOf("LSC") != -1) || (result[o].indexOf("HSQ") != -1) || (result[o].indexOf("HSC") != -1)) && (result[o].indexOf('Gain   0.00 dB') == -1)) {

          var lresult = result[o]
            .replace(/\s\s+/g, ' ')
            .replace(/ Hz Gain | dB Q | Hz Q | Hz |:| Q | dB |Fc /g, ',')
            .replace(/ dB/g, ',');

          let eqv = (lresult);
          var param = eqv.split(',')
          //var typeconv //= param[0]
          var correctedfreq = param[2]
          if (correctedfreq >= 22050) {
            correctedfreq = 22049
          }

          if (result[o].indexOf("PK ") != -1) {
            var paramx = lresult.replace(/ ON PK /g, 'Peaking')//Hz,db,Q
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + ',' + param[3] + ',' + param[4])

            // self.logger.info(logPrefix+' filter in line ' + o + " PK " + typeconv + " vvv " + eqs)
            //     self.logger.info(logPrefix+' filter in line ' + o + " 0 " + param[0] + " 1 " + param[1] + " 2 " + param[2] + " 3 " + param[3] + " 4 " + param[4] + " 5 " + param[5] + " coee " + correctedfreq)
          }

          if (result[o].indexOf("LP ") != -1) {
            var paramx = lresult.replace(/ ON LP /g, 'Lowpass')//Hz,Q
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + ',' + "0.7071")
            // self.logger.info(logPrefix+' filter in line ' + o + " LP " + typeconv + " vvv " + eqs)

          }
          if (result[o].indexOf("HP ") != -1) {
            var paramx = lresult.replace(/ ON HP /g, 'Highpass')//Hz,Q
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + ',' + "0.7071")
            //  self.logger.info(logPrefix+' filter in line ' + o + " HP " + paramx)

          }

          if (result[o].indexOf("LS ") != -1) {
            var paramx = lresult.replace(/ ON LS /g, 'Lowshelf')//Hz,dB,S=0.9
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + "," + param[3] + ",0.9")
            // self.logger.info(logPrefix+' filter in line ' + o + " LS " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("HS ") != -1) {
            var paramx = lresult.replace(/ ON HS /g, 'Highshelf')//Hz,dB,S=0.9
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + "," + param[3] + ",0.9")
            // self.logger.info(logPrefix+' filter in line ' + o + " HS " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("NO ") != -1) {
            var paramx = lresult.replace(/ ON NO /g, 'Notch')//Hz
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + ",1")
            // self.logger.info(logPrefix+' filter in line ' + o + " NO " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("LS 6dB ") != -1) {
            var paramx = lresult.replace(/ ON LS 6dB /g, 'Lowshelf')//Hz,dB,S=0.5
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + "," + param[3] + ",0.5")
            // self.logger.info(logPrefix+' filter in line ' + o + " LS " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("HS 6dB ") != -1) {
            var paramx = lresult.replace(/ ON HS 6dB /g, 'Highshelf')//Hz,dB,S=0.5
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + "," + param[3] + ",0.5")
            // self.logger.info(logPrefix+' filter in line ' + o + " HS " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("LS 12dB ") != -1) {
            var paramx = lresult.replace(/ ON LS 12dB /g, 'Lowshelf')//Hz,dB,S=1
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + "," + param[3] + ",1")
            // self.logger.info(logPrefix+' filter in line ' + o + " LS " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("HS 12dB ") != -1) {
            var paramx = lresult.replace(/ ON HS 12dB /g, 'Highshelf')//Hz,dB,S=1
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + "," + param[3] + ",1")
            // self.logger.info(logPrefix+' filter in line ' + o + " HS " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("LP1") != -1) {
            var paramx = lresult.replace(/ ON LP1 /g, 'LowpassFO')//Hz
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq)
            // self.logger.info(logPrefix+' filter in line ' + o + " LP1 " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("HP1") != -1) {
            var paramx = lresult.replace(/ ON HP1 /g, 'HighpassFO')//Hz
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq)
            // self.logger.info(logPrefix+' filter in line ' + o + " HP1 " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("LPQ ") != -1) {
            var paramx = lresult.replace(/ ON LPQ /g, 'Lowpass')//12dB,Hz,Q
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + ',' + param[3])
            // self.logger.info(logPrefix+' filter in line ' + o + " LPQ " + typeconv + " vvv " + eqs)

          }
          if (result[o].indexOf("HPQ ") != -1) {
            var paramx = lresult.replace(/ ON HPQ /g, 'Highpass')//12dB,/Hz,Q
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + ',' + param[3])
            // self.logger.info(logPrefix+' filter in line ' + o + " HPQ " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("LSQ") != -1) {
            var paramx = lresult.replace(/ ON LSQ /g, 'Lowshelf2')//Hz,dB,q
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + "," + param[3] + "," + param[4])
            // self.logger.info(logPrefix+' filter in line ' + o + " LSQ " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("LSC") != -1) {
            var paramx = lresult.replace(/ ON LSC /g, 'Lowshelf2')//Hz,dB,q
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + "," + param[3] + "," + param[4])
            // self.logger.info(logPrefix+' filter in line ' + o + " LSQ " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("HSQ") != -1) {
            var paramx = lresult.replace(/ ON HSQ /g, 'Highshelf2')//Hz,dB,q
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + "," + param[3] + "," + param[4])
            // self.logger.info(logPrefix+' filter in line ' + o + " HSQ " + typeconv + " vvv " + eqs)

          }

          if (result[o].indexOf("HSC") != -1) {
            var paramx = lresult.replace(/ ON HSC /g, 'Highshelf2')//Hz,dB,q
            var param = paramx.split(',')
            var typeconv = param[1]
            var eqs = (correctedfreq + "," + param[3] + "," + param[4])
            // self.logger.info(logPrefix+' filter in line ' + o + " HSQ " + typeconv + " vvv " + eqs)

          }

          var typec = 'type' + nbreq;
          var scopec = 'scope' + nbreq;
          var eqc = 'eq' + nbreq;
          nbreq = nbreq + 1;
          if (EQfilef == 'autoeq') {
            localscope = 'L+R';
          } else {
            localscope = self.config.get('localscope');
          }
          test += ('Eq' + o + '|' + typeconv + '|' + localscope + '|' + eqs + '|');
          //self.logger.info(test)
          self.config.set("nbreq", nbreq - 1);
          self.config.set('effect', true)
          self.config.set('usethispreset', 'no preset used');

          setTimeout(function () {
            self.refreshUI();
            self.createCamilladspfile()
            self.commandRouter.pushToastMessage('info', self.commandRouter.getI18nString('EQ_LOADED_USED'))
          }, 300);
        } else {
          //nothing to do...
        }
      } else {
        self.logger.info(logPrefix + ' Max eq reached')
        self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('MAX_EQ_REACHED'));
      }
    }
    self.config.set('mergedeq', test);
    self.config.set('savednbreq', nbreq - 1)
    self.config.set('savedmergedeq', test)
    self.config.set('autoatt', true)

  } catch (err) {
    self.logger.error(logPrefix + ' failed to read EQ file ' + err);
  }
  return defer.promise;
};

FusionDsp.prototype.updatelist = function (data) {
  const self = this;
  let path = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq//master/results';
  let name = 'README.md';
  let defer = libQ.defer();
  var destpath = ' \'/data/plugins/audio_interface/fusiondsp';
  // self.config.set('importeq', namepath)
  var toDownload = (path + '/' + name + '\'');
  self.logger.info(logPrefix + ' wget \'' + toDownload)
  try {
    execSync("/usr/bin/wget \'" + toDownload + " -O" + destpath + "/downloadedlist.txt\'", {
      uid: 1000,
      gid: 1000
    });
    self.commandRouter.pushToastMessage('info', self.commandRouter.getI18nString('LIST_SUCCESS_UPDATED'))
    self.refreshUI();
    defer.resolve();
  } catch (err) {
    self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('LIST_FAIL_UPDATE'))
    self.logger.error(logPrefix + ' failed to  download file ' + err);
  }
  return defer.promise;
}

FusionDsp.prototype.resampling = function (data) {
  const self = this;
  let defer = libQ.defer();
  var mpdresample = this.getAdditionalConf('audio_interface', 'alsa_controller', 'resampling');
  if (mpdresample) {
    self.logger.error(logPrefix + ' Resampling must be disabled in playback settings in order to enable this feature');
    self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('RESAMPLING_WARN'));
    self.refreshUI();
    return;
  } else {
    let selectedsp = self.config.get('selectedsp')
    if (selectedsp == "convfir") {
      var responseData = {
        title: self.commandRouter.getI18nString('SAMPLE_WARNING_TITLE'),
        message: self.commandRouter.getI18nString('SAMPLE_WARNING_MESS'),
        size: 'lg',
        buttons: [
          {
            name: self.commandRouter.getI18nString('GET_IT'),
            class: 'btn btn-cancel',
            emit: 'closeModals',
            payload: ''
          },
        ]
      }
      self.commandRouter.broadcastMessage("openModal", responseData);
    }

    self.config.set('enableresampling', data['enableresampling'])
    self.config.set('resamplingset', data['resamplingset'].value)
    self.config.set('resamplingq', data['resamplingq'].value)
    if (data['enableresampling']) {
      self.commandRouter.pushToastMessage('info', data['resamplingset'].value + 'Hz ' + data['resamplingq'].value + ' ' + self.commandRouter.getI18nString('VALUE_SAVED_APPLIED'))
      self.logger.info(logPrefix + ' Resampling ' + data['resamplingset'].value + 'Hz ' + data['resamplingq'].value);
    } else {
      self.commandRouter.pushToastMessage('info', self.commandRouter.getI18nString('VALUE_SAVED_APPLIED'))
      self.logger.info(logPrefix + ' Resampling disabled');
    }
    self.createCamilladspfile()
  }
  return defer.promise;
};
//-----------DRC-FIR section----------------

//here we save value for converted file
FusionDsp.prototype.fileconvert = function (data) {
  const self = this;
  let defer = libQ.defer();
  if (data['filetoconvert'].value.includes(' ')) {
    self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('WARN_SPACE_INFILTER'));
    self.logger.error(logPrefix + " File name can't contains a space!")
    return;
  }
  if (data['tc'].value.includes(' ')) {
    self.commandRouter.pushToastMessage('error', 'No space allowed in Target curve name');
    self.logger.error(logPrefix + " Target curve name can't contains a space!")
    return;
  }
  self.config.set('filetoconvert', data['filetoconvert'].value);
  self.config.set('tc', data['tc'].value);
  self.config.set('drcconfig', data['drcconfig'].value);
  self.config.set('drc_sample_rate', data['drc_sample_rate'].value);
  self.config.set('outputfilename', data['outputfilename']);
  self.convert()
  return defer.promise;
};

//here we convert file using sox and generate filter with DRC-FIR
FusionDsp.prototype.convert = function (data) {
  const self = this;
  //let defer = libQ.defer();
  let drcconfig = self.config.get('drcconfig');
  let infile = self.config.get('filetoconvert');
  let sr;
  if (infile != 'choose a file') {

    let outfile = self.config.get('outputfilename').replace(/ /g, '-');
    if ((outfile == '') || (outfile == 'Empty=name-of-file-to-convert')) {
      outfile = infile.replace(/ /g, '-').replace('.wav', '');
    };
    let targetcurve = '\ /usr/share/drc/config/'
    let outsample = self.config.get('drc_sample_rate');
    let tc = self.config.get('tc');
    if (tc != 'choose a file') {
      let tcsimplified = tc.replace('.txt', '');
      let ftargetcurve
      let curve
      if ((outsample == 44100) || (outsample == 48000) || (outsample == 88200) || (outsample == 96000)) {
        if (outsample == 44100) {
          ftargetcurve = '44.1\\ kHz/';
          curve = '44.1'
          sr = '44100';
        } else if (outsample == 48000) {
          ftargetcurve = '48.0\\ kHz/';
          curve = '48.0';
          sr = '48000';
        } else if (outsample == 88200) {
          ftargetcurve = '88.2\\ kHz/';
          curve = '88.2';
          sr = '88200';
        } else if (outsample == 96000) {
          ftargetcurve = '96.0\\ kHz/';
          curve = '96.0';
          sr = '96000';
        };

        let destfile = (filterfolder + outfile + "-" + drcconfig + "-" + tcsimplified + "-" + sr + ".pcm");
        self.commandRouter.loadI18nStrings();
        try {
          let cmdsox = ("/usr/bin/sox " + filtersource + infile + " -t f32 /tmp/tempofilter.pcm rate -v -s " + outsample);
          execSync(cmdsox);
          self.logger.info(logPrefix + cmdsox);
        } catch (e) {
          self.logger.error(logPrefix + ' input file does not exist ' + e);
          self.commandRouter.pushToastMessage('error', 'Sox failed to convert file' + e);
        };
        try {
          let title = self.commandRouter.getI18nString('FILTER_GENE_TITLE') + destfile;
          let mess = self.commandRouter.getI18nString('FILTER_GENE_MESS');
          let modalData = {
            title: title,
            message: mess,
            size: 'lg'
          };
          self.commandRouter.broadcastMessage("openModal", modalData);

          //here we compose cmde for drc
          //  let composedcmde = ("/usr/bin/drc --BCInFile=/tmp/tempofilter.pcm --PSNormType=E --PSNormFactor=1 --PTType=N --PSPointsFile=" + tccurvepath + tc + " --PSOutFile=" + destfile + targetcurve + ftargetcurve + drcconfig + "-" + curve + ".drc");
          let composedcmde = ("/usr/bin/drc --BCInFile=/tmp/tempofilter.pcm --PTType=N --PSPointsFile=" + tccurvepath + tc + " --PSOutFile=" + destfile + targetcurve + ftargetcurve + drcconfig + "-" + curve + ".drc");
          //and execute it...
          execSync(composedcmde, {
            uid: 1000,
            gid: 1000
          });
          self.logger.info(logPrefix + composedcmde);
          self.commandRouter.pushToastMessage('success', 'Filter ' + destfile + ' generated, Refresh the page to see it');
          self.refreshUI()
          // return self.commandRouter.reloadUi();
        } catch (e) {
          self.logger.error(logPrefix + ' drc failed to create filter ' + e);
          self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('FILTER_GENE_FAIL') + e);
        };
      } else {
        self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('FILTER_GENE_FAIL_RATE'));
      };
    } else {
      self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('FILTER_GENE_FAIL_TC'));
    };
  } else {
    self.commandRouter.pushToastMessage('error', self.commandRouter.getI18nString('FILTER_GENE_FAIL_FILE'));
  };
};

//--------------Tools Section----------------

//here we download and install tools
FusionDsp.prototype.installtools = function (data) {
  const self = this;
  return new Promise(function (resolve, reject) {
    try {
      let modalData = {
        title: self.commandRouter.getI18nString('TOOLS_INSTALL_TITLE'),
        message: self.commandRouter.getI18nString('TOOLS_INSTALL_WAIT'),
        size: 'lg'
      };
      //self.commandRouter.pushToastMessage('info', 'Please wait while installing ( up to 30 seconds)');
      self.commandRouter.broadcastMessage("openModal", modalData);

      // let cpz = execSync('/bin/rm /tmp/tools.tar.xz');
      let cp3 = execSync('/usr/bin/wget -P /tmp https://github.com/balbuze/volumio-plugins/raw/alsa_modular/plugins/audio_interface/FusionDsp/tools/tools.tar.xz');
      //  let cp4 = execSync('/bin/mkdir ' + toolspath);
      let cp5 = execSync('tar -xvf /tmp/tools.tar.xz -C /data/' + toolspath);
      let cp6 = execSync('/bin/rm /tmp/tools.tar.xz*');
      self.config.set('toolsfiletoplay', self.commandRouter.getI18nString('TOOLS_CHOOSE_FILE'));
      self.config.set('toolsinstalled', true);
      self.refreshUI();
      setTimeout(function () {

        self.socket.emit('updateDb');
      }, 1500)
    } catch (err) {
      self.logger.error(logPrefix + ' An error occurs while downloading or installing tools');
      self.commandRouter.pushToastMessage('error', 'An error occurs while downloading or installing tools');
    }

    resolve();
  });
};

//here we remove tools
FusionDsp.prototype.removetools = function (data) {
  const self = this;

  self.commandRouter.pushToastMessage('info', self.commandRouter.getI18nString('TOOLS_REMOVE'));
  return new Promise(function (resolve, reject) {

    try {

      let cp6 = execSync('/bin/rm /data/' + toolspath + "/*");
    } catch (err) {
      self.logger.error(logPrefix + ' An error occurs while removing tools');
      self.commandRouter.pushToastMessage('error', 'An error occurs while removing tools');
    }
    resolve();

    self.config.set('toolsinstalled', false);
    self.config.set('toolsfiletoplay', self.commandRouter.getI18nString('TOOLS_NO_FILE'));
    self.refreshUI();
    self.socket.emit('updateDb');

  });
};
//------ actions tools------------

FusionDsp.prototype.playToolsFile = function (data) {
  const self = this;
  self.config.set('toolsfiletoplay', data['toolsfiletoplay'].value);
  let toolsfile = self.config.get("toolsfiletoplay");
  let track = toolspath + toolsfile;
  self.commandRouter.replaceAndPlay({ uri: track });
  self.commandRouter.volumioClearQueue();
};


FusionDsp.prototype.sendvolumelevel = function () {
  const self = this;
  // let data = self.commandRouter.volumioGetState();

  self.socket.on('pushState', function (data) {
    let loudnessVolumeThreshold = self.config.get('loudnessthreshold')
    let loudnessMaxGain = 23 //15
    let loudnessLowThreshold = 5 //10
    let loudnessRange = loudnessVolumeThreshold - loudnessLowThreshold
    let ratio = loudnessMaxGain / loudnessRange
    let loudnessGain

    if (data.volume > loudnessLowThreshold && data.volume < loudnessVolumeThreshold) {
      loudnessGain = ratio * (loudnessVolumeThreshold - data.volume)
    } else if (data.volume <= loudnessLowThreshold) {
      loudnessGain = loudnessMaxGain
    } else if (data.volume >= loudnessVolumeThreshold) {
      loudnessGain = 0
    }

    self.logger.info(logPrefix + ' volume level for loudness ' + data.volume + ' gain applied ' + Number.parseFloat(loudnessGain).toFixed(2))
    self.config.set('loudnessGain', Number.parseFloat(loudnessGain).toFixed(2))
    self.createCamilladspfile()
  })
}

FusionDsp.prototype.reportFusionEnabled = function () {
  const self = this;

  self.logger.info(logPrefix + ' Reporting Fusion DSP Enabled');
  var fusionDSPElementsData = { "id": "fusiondspeq", "sub_type": "dsp_plugin", "preset": "FusionDSP", "quality": "enhanced" };
  try {
    self.commandRouter.addDSPSignalPathElement(fusionDSPElementsData);
  } catch (e) { }
}

FusionDsp.prototype.reportFusionDisabled = function () {
  const self = this;

  self.logger.info(logPrefix + ' Reporting Fusion DSP Disabled');
  try {
    self.commandRouter.removeDSPSignalPathElement({ "id": "fusiondspeq" });
  } catch (e) { }
}
