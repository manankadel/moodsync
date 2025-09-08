import requests

api_key = '12bbc3118dc24fdd071e4fa87cc1aef7'
city = 'London'
url = f"http://api.openweathermap.org/data/2.5/weather?q={city}&appid={api_key}&units=metric"

try:
    response = requests.get(url)
    weather_data = response.json()
    
    # Extract key weather information
    main_weather = weather_data['weather'][0]['main']
    description = weather_data['weather'][0]['description']
    temperature = weather_data['main']['temp']
    
    print(f"Weather in {city}:")
    print(f"Condition: {main_weather}")
    print(f"Description: {description}")
    print(f"Temperature: {temperature}°C")

except Exception as e:
    print(f"An error occurred: {e}")