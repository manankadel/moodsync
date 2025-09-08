/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Add this images block
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'i.scdn.co',
        port: '',
        pathname: '/image/**',
      },
    ],
  },
};

export default nextConfig;