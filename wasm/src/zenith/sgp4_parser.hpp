#pragma once

/// @file sgp4_parser.hpp
/// @brief TLE (Two-Line Element set) parser for NORAD format.
///        Parses standard TLE files and strings into TLEData structs.
///
/// TLE Format Reference:
///   Line 1: 1 NNNNNC NNNNNAAA NNNNN.NNNNNNNN +.NNNNNNNN +NNNNN+N +NNNNN+N NNNNNN
///   Line 2: 2 NNNNN NNN.NNNN NNN.NNNN NNNNNNN NNN.NNNN NNN.NNNN NN.NNNNNNNNNNNNNN
///
/// References:
///   - CelesTrak TLE format: https://celestrak.org/NORAD/documentation/tle-fmt.php
///   - Vallado, "Fundamentals of Astrodynamics and Applications", 4th ed.

#include "orbit_types.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace orbit {

// ============================================================================
// Constants
// ============================================================================

/// Expected length of a TLE line (69 characters).
inline constexpr int TLE_LINE_LENGTH = 69;

/// Maximum allowed tolerance in characters for short/long TLE lines.
inline constexpr int TLE_LENGTH_TOLERANCE = 2;

// ============================================================================
// Internal Helpers
// ============================================================================

/// Extract a substring from fixed-width columns, trim whitespace, return as string.
/// @param line   The source line.
/// @param start  1-based column start index.
/// @param width  Number of characters to extract.
/// @return Trimmed substring, or empty string on out-of-bounds.
inline std::string parse_fixed_width(const std::string& line, int start, int width) {
    // Convert to 0-based indexing.
    int idx = start - 1;
    if (idx < 0 || idx >= static_cast<int>(line.size())) {
        return "";
    }
    int end = idx + width;
    if (end > static_cast<int>(line.size())) {
        end = static_cast<int>(line.size());
    }
    std::string result = line.substr(idx, end - idx);

    // Trim leading and trailing whitespace.
    auto first = result.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) {
        return "";
    }
    auto last = result.find_last_not_of(" \t\r\n");
    return result.substr(first, last - first + 1);
}

/// Parse a fixed-width field to double. Returns default_val on failure.
inline double parse_fixed_double(const std::string& line, int start, int width,
                                 double default_val = 0.0) {
    std::string token = parse_fixed_width(line, start, width);
    if (token.empty()) {
        return default_val;
    }
    try {
        return std::stod(token);
    } catch (const std::exception&) {
        return default_val;
    }
}

/// Parse a fixed-width field to int. Returns default_val on failure.
inline int parse_fixed_int(const std::string& line, int start, int width,
                           int default_val = 0) {
    std::string token = parse_fixed_width(line, start, width);
    if (token.empty()) {
        return default_val;
    }
    try {
        return std::stoi(token);
    } catch (const std::exception&) {
        return default_val;
    }
}

// ============================================================================
// Checksum Validation
// ============================================================================

/// Validate the checksum of a TLE line.
/// The checksum is the sum of all digit values in the line, minus the sign
/// characters (+, -) count as 1 each, and all other non-digit characters
/// (spaces, periods, etc.) are ignored.  The result mod 10 must equal the
/// checksum digit (column 69).
///
/// @param line  A 69-character TLE line.
/// @return true if the checksum matches.
inline bool validate_checksum(const std::string& line) {
    if (static_cast<int>(line.size()) < TLE_LINE_LENGTH) {
        return false;
    }

    int sum = 0;
    for (int i = 0; i < TLE_LINE_LENGTH - 1; ++i) {
        char c = line[i];
        if (std::isdigit(static_cast<unsigned char>(c))) {
            sum += c - '0';
        } else if (c == '+' || c == '-') {
            sum += 1;
        }
        // All other characters (space, period, letter) contribute 0.
    }

    int expected = line[TLE_LINE_LENGTH - 1] - '0';
    if (expected < 0 || expected > 9) {
        return false;
    }

    return (sum % 10) == expected;
}

// ============================================================================
// Line 1 Parser
// ============================================================================

/// Parse TLE Line 1 into TLEData fields.
///
/// Line 1 fields (1-based columns):
///    1  : Line number (always '1')
///    3-7: NORAD catalog number (5 digits)
///    8  : Classification (U/S/C)
///   10-11: Launch year (2-digit)
///   12-14: Launch piece (3 chars)
///   16-17: Epoch year (2-digit)
///   18-32: Epoch day of year (14 digits, fractional)
///   34-43: First derivative of mean motion
///   45-52: Second derivative of mean motion (decimal point assumed)
///   54-61: B* drag term (decimal point assumed, leading sign)
///   63   : Ephemeris type
///   65-68: Element set number
///   69   : Checksum (mod 10)
///
/// @param line  The first TLE line.
/// @param[out] data  TLEData struct to populate.
/// @return true if parsing succeeded.
inline bool parse_tle_line1(const std::string& line, TLEData& data) {
    // Validate line number.
    if (line.empty() || line[0] != '1') {
        return false;
    }

    // Validate length (allow small tolerance for trailing whitespace).
    if (static_cast<int>(line.size()) < TLE_LINE_LENGTH - TLE_LENGTH_TOLERANCE) {
        return false;
    }

    // Validate checksum.
    if (!validate_checksum(line)) {
        return false;
    }

    // NORAD catalog number (columns 3-7).
    data.norad_id = parse_fixed_int(line, 3, 5);
    if (data.norad_id <= 0) {
        return false;
    }

    // Classification (column 8).
    std::string class_str = parse_fixed_width(line, 8, 1);
    data.classification = class_str.empty() ? 'U' : class_str[0];

    // Epoch year and day.
    // The CelesTrak spec places epoch year at columns 16-17 and epoch day at
    // columns 18-32.  However, real NORAD TLEs have the international
    // designator letter at column 15, pushing the epoch to start at column 19.
    // We handle both formats: if columns 16-17 contain a valid 2-digit year,
    // use them; otherwise, read the combined epoch field from columns 19-32.
    int epoch_year_16 = parse_fixed_int(line, 16, 2);
    if (epoch_year_16 > 0) {
        // Ideal CelesTrak format: epoch year at 16-17, epoch day at 18-32.
        data.epoch_year = epoch_year_16;
        data.epoch_day = parse_fixed_double(line, 18, 15);
    } else {
        // Real NORAD format: combined epoch field at columns 19-32.
        // The first 2 digits are the year, followed by the fractional day.
        std::string epoch_str = parse_fixed_width(line, 19, 14);
        if (epoch_str.size() >= 3) {
            try {
                // Parse as double: YYDDD.DDDDDDDD
                double epoch_val = std::stod(epoch_str);
                // Extract year from the integer part.
                int year_int = static_cast<int>(std::floor(epoch_val));
                // Year is the first 2 digits of the integer part.
                data.epoch_year = year_int / 1000;
                // Day is the value with year prefix removed.
                data.epoch_day = epoch_val - (year_int / 1000) * 1000.0;
            } catch (const std::exception&) {
                data.epoch_year = 0;
                data.epoch_day = 0.0;
            }
        } else {
            // Fallback: try columns 18-32.
            data.epoch_year = parse_fixed_int(line, 18, 2);
            data.epoch_day = parse_fixed_double(line, 20, 13);
        }
    }

    // First derivative of mean motion (columns 34-43):
    // stored but not in TLEData (would need additional field; skipping for now).

    // Second derivative of mean motion (columns 45-52):
    // uses implicit decimal point.

    // B* drag term (columns 54-61).
    // The TLE format uses an implicit decimal point and a leading sign.
    // Example: "12345-6" means 12345 * 10^-6, "+1234+3" means +1234 * 10^+3.
    std::string bstar_str = parse_fixed_width(line, 54, 8);
    if (!bstar_str.empty()) {
        // Find the sign character to determine the exponent.
        size_t sign_pos = bstar_str.find_last_of("+-");
        if (sign_pos != std::string::npos && sign_pos > 0) {
            std::string mantissa_part = bstar_str.substr(0, sign_pos);
            std::string exponent_part = bstar_str.substr(sign_pos);

            // Insert implicit decimal point after first digit.
            // Handle the leading sign on mantissa.
            std::string mantissa_clean;
            bool negative = false;
            size_t start_idx = 0;
            if (!mantissa_part.empty() && (mantissa_part[0] == '+' || mantissa_part[0] == '-')) {
                negative = (mantissa_part[0] == '-');
                start_idx = 1;
            }
            if (mantissa_part.size() > start_idx) {
                mantissa_clean = std::string(1, mantissa_part[start_idx]);
                if (mantissa_part.size() > start_idx + 1) {
                    mantissa_clean += ".";
                    mantissa_clean += mantissa_part.substr(start_idx + 1);
                }
            }
            if (negative) {
                mantissa_clean = "-" + mantissa_clean;
            }

            try {
                double mantissa = std::stod(mantissa_clean);
                int exponent = std::stoi(exponent_part);
                data.bstar = mantissa * std::pow(10.0, exponent);
            } catch (const std::exception&) {
                data.bstar = 0.0;
            }
        } else {
            try {
                data.bstar = std::stod(bstar_str);
            } catch (const std::exception&) {
                data.bstar = 0.0;
            }
        }
    }

    // Store raw lines.
    data.line1 = line;

    return true;
}

// ============================================================================
// Line 2 Parser
// ============================================================================

/// Parse TLE Line 2 into TLEData fields.
///
/// Line 2 fields (1-based columns):
///    1  : Line number (always '2')
///    3-7: NORAD catalog number
///    9-16: Inclination (degrees)
///   18-25: RAAN (degrees)
///   27-33: Eccentricity (decimal point assumed, leading 0)
///   35-42: Argument of perigee (degrees)
///   44-51: Mean anomaly (degrees)
///   53-63: Mean motion (revolutions per day)
///   64-68: Revolution number at epoch
///   69   : Checksum (mod 10)
///
/// @param line  The second TLE line.
/// @param[out] data  TLEData struct to populate.
/// @return true if parsing succeeded.
inline bool parse_tle_line2(const std::string& line, TLEData& data) {
    // Validate line number.
    if (line.empty() || line[0] != '2') {
        return false;
    }

    // Validate length.
    if (static_cast<int>(line.size()) < TLE_LINE_LENGTH - TLE_LENGTH_TOLERANCE) {
        return false;
    }

    // Validate checksum.
    if (!validate_checksum(line)) {
        return false;
    }

    // Inclination (columns 9-16).
    data.inc_deg = parse_fixed_double(line, 9, 8);

    // RAAN (columns 18-25).
    data.raan_deg = parse_fixed_double(line, 18, 8);

    // Eccentricity (columns 27-33).
    // The TLE format omits the decimal point; it is assumed to be 0.xxxxxxx.
    std::string ecc_str = parse_fixed_width(line, 27, 7);
    if (!ecc_str.empty()) {
        try {
            data.ecc = std::stod("0." + ecc_str);
        } catch (const std::exception&) {
            data.ecc = 0.0;
        }
    }

    // Argument of perigee (columns 35-42).
    data.argp_deg = parse_fixed_double(line, 35, 8);

    // Mean anomaly (columns 44-51).
    data.mean_anomaly_deg = parse_fixed_double(line, 44, 8);

    // Mean motion (columns 53-63).
    data.mean_motion_rev_day = parse_fixed_double(line, 53, 11);

    // Revolution number at epoch (columns 64-68).
    data.revolution_number = parse_fixed_int(line, 64, 5);

    // Store raw line.
    data.line2 = line;

    return true;
}

// ============================================================================
// Combined Parser
// ============================================================================

/// Parse a pair of TLE lines into a TLEData struct.
///
/// @param line1  The first TLE line.
/// @param line2  The second TLE line.
/// @return Parsed TLEData.  On failure, all fields are zero/empty.
inline TLEData parse_tle(const std::string& line1, const std::string& line2) {
    TLEData data;

    if (!parse_tle_line1(line1, data)) {
        return TLEData{};
    }

    if (!parse_tle_line2(line2, data)) {
        return TLEData{};
    }

    // Cross-validate NORAD catalog numbers.
    int id_line1 = data.norad_id;
    int id_line2 = parse_fixed_int(line2, 3, 5);
    if (id_line1 != id_line2) {
        return TLEData{};
    }

    return data;
}

// ============================================================================
// File Parsing
// ============================================================================

/// Parse a TLE file containing multiple TLE sets.
/// Each TLE set consists of two consecutive lines (line1 then line2).
/// Blank lines and comment lines (starting with '#') are skipped.
///
/// @param filename  Path to the TLE file.
/// @return Vector of parsed TLEData structs.
inline std::vector<TLEData> parse_tle_file(const std::string& filename) {
    std::vector<TLEData> results;

    std::ifstream file(filename);
    if (!file.is_open()) {
        return results;
    }

    std::string line;
    std::string pending_line1;

    while (std::getline(file, line)) {
        // Strip carriage return (Windows line endings).
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }

        // Skip blank lines.
        if (line.find_first_not_of(" \t") == std::string::npos) {
            continue;
        }

        // Skip comment lines.
        if (line[0] == '#') {
            continue;
        }

        // Check for line 1 or line 2.
        if (!line.empty() && line[0] == '1') {
            pending_line1 = line;
        } else if (!line.empty() && line[0] == '2') {
            if (!pending_line1.empty()) {
                TLEData data = parse_tle(pending_line1, line);
                if (data.norad_id > 0) {
                    results.push_back(data);
                }
                pending_line1.clear();
            }
        } else {
            // Unknown line; reset pending.
            pending_line1.clear();
        }
    }

    return results;
}

// ============================================================================
// String Parsing
// ============================================================================

/// Parse a multi-line string containing TLE data.
/// Each TLE set consists of two consecutive lines (line1 then line2).
/// Blank lines and comment lines (starting with '#') are skipped.
///
/// @param tle_text  String containing TLE data.
/// @return Vector of parsed TLEData structs.
inline std::vector<TLEData> parse_tle_string(const std::string& tle_text) {
    std::vector<TLEData> results;
    std::istringstream stream(tle_text);
    std::string line;
    std::string pending_line1;

    while (std::getline(stream, line)) {
        // Strip carriage return.
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }

        // Skip blank lines.
        if (line.find_first_not_of(" \t") == std::string::npos) {
            continue;
        }

        // Skip comment lines.
        if (line[0] == '#') {
            continue;
        }

        // Check for line 1 or line 2.
        if (!line.empty() && line[0] == '1') {
            pending_line1 = line;
        } else if (!line.empty() && line[0] == '2') {
            if (!pending_line1.empty()) {
                TLEData data = parse_tle(pending_line1, line);
                if (data.norad_id > 0) {
                    results.push_back(data);
                }
                pending_line1.clear();
            }
        } else {
            pending_line1.clear();
        }
    }

    return results;
}

}  // namespace orbit
