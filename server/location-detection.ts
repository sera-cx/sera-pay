/**
 * Location Detection Service
 * Detects customer location from IP address and maps to local currency
 */

import { request } from 'https';
import { request as httpRequest } from 'http';
import { seraFxService } from './sera-fx-service';

export interface LocationInfo {
  country: string;
  countryCode: string;
  currency: string;
  city?: string;
  region?: string;
  ip: string;
}

export interface GeoIPResponse {
  country?: string;
  country_code?: string;
  city?: string;
  region?: string;
  ip?: string;
}

class LocationDetectionService {
  private cache: Map<string, { data: LocationInfo; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Get client IP from request
   */
  getClientIp(req: any): string {
    const forwarded = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    const remoteAddr = req.socket?.remoteAddress || req.connection?.remoteAddress;

    if (forwarded) {
      return (forwarded as string).split(',')[0].trim();
    }
    if (realIp) {
      return realIp as string;
    }
    if (remoteAddr) {
      return remoteAddr;
    }
    return '127.0.0.1';
  }

  /**
   * Fetch geo location from IP address using free geoip API
   */
  private async fetchGeoLocation(ip: string): Promise<GeoIPResponse> {
    return new Promise((resolve, reject) => {
      const url = `https://ipapi.co/${ip}/json/`;
      const protocol = url.startsWith('https') ? request : httpRequest;

      protocol(url, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (error) {
            reject(new Error('Failed to parse geo location response'));
          }
        });
      }).on('error', reject).end();
    });
  }

  /**
   * Detect location from IP address
   */
  async detectLocation(ip: string): Promise<LocationInfo> {
    // Check cache
    const cached = this.cache.get(ip);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    try {
      const geoData = await this.fetchGeoLocation(ip);
      const countryCode = geoData.country_code || 'US';
      const currency = seraFxService.detectCurrencyFromCountry(countryCode) || 'USD';

      const locationInfo: LocationInfo = {
        country: geoData.country || 'United States',
        countryCode,
        currency,
        city: geoData.city,
        region: geoData.region,
        ip,
      };

      // Cache the result
      this.cache.set(ip, { data: locationInfo, timestamp: Date.now() });

      return locationInfo;
    } catch (error) {
      console.error('[LocationDetection] Failed to detect location:', error);
      // Return default US location on error
      return {
        country: 'United States',
        countryCode: 'US',
        currency: 'USD',
        ip,
      };
    }
  }

  /**
   * Detect currency from request
   */
  async detectCurrencyFromRequest(req: any): Promise<string> {
    const ip = this.getClientIp(req);
    const location = await this.detectLocation(ip);
    return location.currency;
  }

  /**
   * Get full location info from request
   */
  async getLocationFromRequest(req: any): Promise<LocationInfo> {
    const ip = this.getClientIp(req);
    return this.detectLocation(ip);
  }

  /**
   * Clear cache for specific IP
   */
  clearCache(ip: string): void {
    this.cache.delete(ip);
  }

  /**
   * Clear all cache
   */
  clearAllCache(): void {
    this.cache.clear();
  }
}

// Export singleton instance
export const locationDetectionService = new LocationDetectionService();
