const path = require('path');

module.exports = {
  apps: [
    {
      name: 'pons-launcher',
      script: 'server.js',
      cwd: path.join(__dirname, 'backend'),
      instances: 1,
      // Never cluster this: two processes would assign the same nonces and
      // double-broadcast a bundle.
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      out_file: path.join(__dirname, 'logs/out.log'),
      error_file: path.join(__dirname, 'logs/err.log'),
      time: true,
    },
  ],
};
