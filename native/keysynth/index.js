// 빌드 결과를 그대로 내보낸다. 없으면 require가 실패하고, 부르는 쪽(src/service/keySynth.js)이 osascript로 내려간다.
module.exports = require('./build/Release/keysynth.node');
