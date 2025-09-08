class MoodVisualizer {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.setupCanvas();
        this.currentMood = null;
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

    createParticles(mood) {
        this.particles = [];
        const particleCount = 100;
        const colors = {
            'happy': ['#FFD700', '#FF6B6B', '#4ECDC4'],
            'sad': ['#4A90E2', '#5BCAFF', '#1A2980'],
            'energetic': ['#FF4500', '#FF6B6B', '#FF9A3C']
        };

        for (let i = 0; i < particleCount; i++) {
            this.particles.push({
                x: Math.random() * this.canvas.width,
                y: Math.random() * this.canvas.height,
                radius: Math.random() * 3 + 1,
                color: colors[mood][Math.floor(Math.random() * colors[mood].length)],
                speedX: (Math.random() - 0.5) * 2,
                speedY: (Math.random() - 0.5) * 2,
                alpha: 0.7
            });
        }
    }

    animate(mood) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.particles.forEach((particle, index) => {
            // Update particle position
            particle.x += particle.speedX;
            particle.y += particle.speedY;

            // Bounce off walls
            if (particle.x < 0 || particle.x > this.canvas.width) particle.speedX *= -1;
            if (particle.y < 0 || particle.y > this.canvas.height) particle.speedY *= -1;

            // Draw particle
            this.ctx.beginPath();
            this.ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
            this.ctx.fillStyle = particle.color;
            this.ctx.globalAlpha = particle.alpha;
            this.ctx.fill();
        });

        requestAnimationFrame(() => this.animate(mood));
    }

    setMood(mood) {
        this.currentMood = mood;
        this.createParticles(mood);
    }
}

// Initialize mood visualizer
const moodVisualizer = new MoodVisualizer('moodCanvas');