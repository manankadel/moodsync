document.addEventListener('DOMContentLoaded', () => {
    // --- Mood selection for visualizer (unchanged) ---
    document.querySelectorAll('.mood-option input').forEach(option => {
        option.addEventListener('change', (e) => {
            moodVisualizer.setMood(e.target.value);
        });
    });

    // --- Form for CREATING a room ---
    const generateForm = document.getElementById('generate-form');
    generateForm.addEventListener('submit', (e) => {
        // Check if a mood is selected
        const selectedMood = document.querySelector('input[name="mood"]:checked');
        if (!selectedMood) {
            e.preventDefault(); // Stop form submission
            alert('Please select a mood to create a room!');
            return;
        }
        // Set the current hour before submitting
        document.getElementById('hour-input').value = new Date().getHours();
    });

    // --- Form for JOINING a room ---
    const joinForm = document.getElementById('join-form');
    joinForm.addEventListener('submit', (e) => {
        e.preventDefault(); // We'll handle the redirect ourselves
        const roomCodeInput = document.getElementById('room-code-input');
        const roomCode = roomCodeInput.value.trim().toUpperCase();

        if (roomCode) {
            // Redirect the user to the room URL
            window.location.href = `/room/${roomCode}`;
        } else {
            alert('Please enter a room code.');
        }
    });

    // Initial animation
    moodVisualizer.animate();
});