class PlaylistVisualizer {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.setupCanvas();
    }

    setupCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        window.addEventListener('resize', () => this.resizeCanvas());
    }

    resizeCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    createMusicWaveParticles() {
        this.particles = [];
        const particleCount = 200;
        const colors = ['#00f260', '#0575e6', '#4ECDC4'];

        for (let i = 0; i < particleCount; i++) {
            this.particles.push({
                x: Math.random() * this.canvas.width,
                y: this.canvas.height / 2 + Math.sin(i * 0.1) * 100,
                radius: Math.random() * 3 + 1,
                color: colors[Math.floor(Math.random() * colors.length)],
                speed: Math.random() * 2 + 1,
                amplitude: Math.random() * 50 + 20
            });
        }
    }

    animate() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.particles.forEach((particle, index) => {
            // Update particle position with wave-like motion
            particle.x -= particle.speed;
            particle.y = this.canvas.height / 2 + 
                         Math.sin(particle.x * 0.01) * particle.amplitude;

            // Reset particle position when it goes off-screen
            if (particle.x < 0) {
                particle.x = this.canvas.width;
            }

            // Draw particle
            this.ctx.beginPath();
            this.ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
            this.ctx.fillStyle = particle.color;
            this.ctx.globalAlpha = 0.7;
            this.ctx.fill();
        });

        requestAnimationFrame(() => this.animate());
    }

    init() {
        this.createMusicWaveParticles();
        this.animate();
    }
}

// Initialize playlist visualizer
document.addEventListener('DOMContentLoaded', () => {
    const playlistVisualizer = new PlaylistVisualizer('playlistCanvas');
    playlistVisualizer.init();
});