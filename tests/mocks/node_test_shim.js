
module.exports = global.it || function() {};
module.exports.test = global.it || function() {};
module.exports.describe = global.describe || function() {};
module.exports.before = global.beforeAll || function() {};
module.exports.after = global.afterAll || function() {};
module.exports.beforeEach = global.beforeEach || function() {};
module.exports.afterEach = global.afterEach || function() {};
module.exports.skip = (global.it && global.it.skip) || function() {};
module.exports.only = (global.it && global.it.only) || function() {};
