"use client";

import { useEffect, useState } from "react";
import type { CustomerDisplayWeatherSettings } from "@rop/contracts";

type WeatherState = {
  temperature: number;
  code: number;
} | null;

type ZipCoordinates = {
  latitude: string;
  longitude: string;
} | null;

type ZipLookupResponse = {
  places?: Array<{
    latitude?: string;
    longitude?: string;
  }>;
};

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const zipCoordinateCache = new Map<string, Promise<ZipCoordinates>>();

// WMO weather interpretation codes → emoji
// https://open-meteo.com/en/docs (see "Weather variable documentation")
function wmoToEmoji(code: number) {
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤";
  if (code === 3) return "☁️";
  if (code <= 48) return "🌫";
  if (code <= 57) return "🌦";
  if (code <= 67) return "🌧";
  if (code <= 77) return "❄️";
  if (code <= 82) return "🌧";
  if (code <= 86) return "🌨";
  if (code <= 99) return "⛈";
  return "☁️";
}

function wmoToLabel(code: number) {
  if (code === 0) return "Clear";
  if (code <= 2) return "Partly sunny";
  if (code === 3) return "Cloudy";
  if (code <= 48) return "Foggy";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  if (code <= 86) return "Snow showers";
  if (code <= 99) return "Thunderstorm";
  return "Overcast";
}

async function resolveZipCoordinates(countryCode: string, zipCode: string) {
  const normalizedCountry = countryCode.trim().toLowerCase() || "us";
  const normalizedZip = zipCode.trim();
  const cacheKey = `${normalizedCountry}:${normalizedZip}`;
  const cached = zipCoordinateCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const lookup = fetch(`https://api.zippopotam.us/${encodeURIComponent(normalizedCountry)}/${encodeURIComponent(normalizedZip)}`, {
    cache: "force-cache"
  })
    .then(async (response): Promise<ZipCoordinates> => {
      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as ZipLookupResponse;
      const place = data.places?.[0];
      if (!place?.latitude || !place.longitude) {
        return null;
      }

      return {
        latitude: place.latitude,
        longitude: place.longitude
      };
    })
    .catch(() => null);

  zipCoordinateCache.set(cacheKey, lookup);
  return lookup;
}

export function CustomerDisplayWeather({
  config
}: {
  config: CustomerDisplayWeatherSettings | null;
}) {
  const [weather, setWeather] = useState<WeatherState>(null);
  const enabled = config?.enabled ?? false;
  const zipCode = config?.zipCode.trim() ?? "";
  const countryCode = config?.countryCode.trim() || "US";
  const unit = config?.unit ?? "fahrenheit";

  useEffect(() => {
    setWeather(null);

    if (!enabled || !zipCode) {
      return;
    }

    let cancelled = false;

    const fetchWeather = async () => {
      try {
        const coordinates = await resolveZipCoordinates(countryCode, zipCode);
        if (!coordinates) {
          return;
        }

        const url = new URL("https://api.open-meteo.com/v1/forecast");
        url.searchParams.set("latitude", coordinates.latitude);
        url.searchParams.set("longitude", coordinates.longitude);
        url.searchParams.set("current", "temperature_2m,weather_code");
        url.searchParams.set("temperature_unit", unit);
        url.searchParams.set("timezone", "auto");

        const response = await fetch(url.toString(), { cache: "no-store" });
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as {
          current?: { temperature_2m?: number; weather_code?: number };
        };
        if (cancelled) {
          return;
        }
        if (
          typeof data.current?.temperature_2m === "number" &&
          typeof data.current?.weather_code === "number"
        ) {
          setWeather({
            temperature: data.current.temperature_2m,
            code: data.current.weather_code
          });
        }
      } catch {
        // Network error — leave previous reading in place.
      }
    };

    void fetchWeather();
    const interval = window.setInterval(fetchWeather, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [countryCode, enabled, unit, zipCode]);

  if (!enabled || !zipCode) {
    return null;
  }

  const unitSymbol = unit === "celsius" ? "°C" : "°F";
  const weatherLabel = weather ? `Current weather: ${wmoToLabel(weather.code)}` : "Current weather loading";

  return (
    <div className="customer-display-weather" aria-label={weatherLabel}>
      <span className="customer-display-weather-icon" aria-hidden="true">
        {weather ? wmoToEmoji(weather.code) : "☁️"}
      </span>
      <span className="customer-display-weather-temp">
        {weather ? `${Math.round(weather.temperature)}${unitSymbol}` : `--${unitSymbol}`}
      </span>
    </div>
  );
}
