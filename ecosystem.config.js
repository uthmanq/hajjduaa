// PM2 process file. Run: `pm2 start ecosystem.config.js && pm2 save`.
module.exports = {
  apps: [
    {
      name: 'hajjduaa',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '256M',
      out_file: '/var/log/hajjduaa/out.log',
      error_file: '/var/log/hajjduaa/err.log',
      time: true
    }
  ]
};
