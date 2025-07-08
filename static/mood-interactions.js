document.addEventListener('DOMContentLoaded', () => {
    const moodOptions = document.querySelectorAll('.mood-option input');
    const generateBtn = document.getElementById('generatePlaylist');
    let selectedMood = null;

    // Mood selection
    moodOptions.forEach(option => {
        option.addEventListener('change', (e) => {
            selectedMood = e.target.value;
            moodVisualizer.setMood(selectedMood);
        });
    });

    // Generate playlist
    generateBtn.addEventListener('click', (e) => {
        if (!selectedMood) {
            alert('Please select a mood first!');
            return;
        }

        // Create form dynamically
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = '/generate';

        // Mood input
        const moodInput = document.createElement('input');
        moodInput.type = 'hidden';
        moodInput.name = 'mood';
        moodInput.value = selectedMood;
        form.appendChild(moodInput);

        // Hour input
        const hourInput = document.createElement('input');
        hourInput.type = 'hidden';
        hourInput.name = 'hour';
        hourInput.value = new Date().getHours();
        form.appendChild(hourInput);

        // Append and submit
        document.body.appendChild(form);
        form.submit();
    });

    // Initial animation
    moodVisualizer.animate();
});