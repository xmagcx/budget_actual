process.env.ACTUAL_DISABLE_FRONTEND = 'true';

const { app } = await import('./app.js');

// Vercel Node runtime entrypoint: reuse the same Express app without binding a port.
export default app;
