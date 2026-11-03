<?php
/**
 * API Jadwal Sholat (proxy + cache ke data Bimas Islam Kemenag RI).
 *
 *   GET api.php?action=cities                           → daftar kab/kota
 *   GET api.php?action=schedule&city=1301&year=2026&month=11
 *   GET api.php?action=locate&lat=-6.2&lon=106.8        → kab/kota terdekat
 */
declare(strict_types=1);

require __DIR__ . '/src/bootstrap.php';

set_exception_handler(static function (Throwable $e): void {
    if ($e instanceof ApiError) {
        send_json(['ok' => false, 'error' => $e->getMessage()], $e->status);
    }
    error_log('[jadwal-sholat] ' . $e);
    send_json(['ok' => false, 'error' => 'Terjadi kesalahan pada server.'], 500);
});

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET' && $method !== 'HEAD') {
    header('Allow: GET, HEAD');
    throw new ApiError('Metode tidak diizinkan.', 405);
}

$action = is_string($_GET['action'] ?? null) ? $_GET['action'] : '';

match ($action) {
    'cities'   => action_cities(),
    'schedule' => action_schedule(),
    'locate'   => action_locate(),
    default    => throw new ApiError('Aksi tidak dikenal.', 404),
};

/* ------------------------------------------------------------------ */

/** @return array<string,string> id → lokasi */
function cities(): array
{
    return remember('cities', 30 * 86400, static function (): array {
        $res = http_get_json(UPSTREAM_BASE . '/sholat/kota/semua');
        if (empty($res['status']) || !is_array($res['data'] ?? null)) {
            throw new RuntimeException('Daftar kota tidak valid');
        }
        $out = [];
        foreach ($res['data'] as $row) {
            $id = (string) ($row['id'] ?? '');
            $name = clean_text($row['lokasi'] ?? '');
            if (preg_match('/^\d{4}$/', $id) && $name !== '') {
                $out[$id] = $name;
            }
        }
        if (count($out) < 100) {
            throw new RuntimeException('Daftar kota terlalu sedikit');
        }
        asort($out);
        return $out;
    });
}

function action_cities(): never
{
    rate_limit('api', 120, 60);
    $list = [];
    foreach (cities() as $id => $name) {
        $list[] = ['id' => (string) $id, 'lokasi' => $name];
    }
    send_json(['ok' => true, 'data' => $list], 200, 86400);
}

function int_param(string $name, int $min, int $max): int
{
    $v = $_GET[$name] ?? null;
    if (!is_string($v) || !preg_match('/^\d{1,4}$/', $v) || (int) $v < $min || (int) $v > $max) {
        throw new ApiError("Parameter '$name' tidak valid.");
    }
    return (int) $v;
}

function action_schedule(): never
{
    rate_limit('api', 120, 60);

    $city = $_GET['city'] ?? '';
    if (!is_string($city) || !preg_match('/^\d{4}$/', $city) || !isset(cities()[$city])) {
        throw new ApiError('Kota tidak ditemukan.', 404);
    }
    $nowYear = (int) date('Y');
    $year  = int_param('year', $nowYear - 1, $nowYear + 1);
    $month = int_param('month', 1, 12);
    $ym    = sprintf('%04d-%02d', $year, $month);

    $isPast = $ym < date('Y-m');
    $data = remember("jadwal_{$city}_{$ym}", $isPast ? 60 * 86400 : 7 * 86400,
        static function () use ($city, $year, $month): array {
            $url = sprintf('%s/sholat/jadwal/%s/%04d/%02d', UPSTREAM_BASE, $city, $year, $month);
            $res = http_get_json($url);
            $d = $res['data'] ?? null;
            if (empty($res['status']) || !is_array($d) || !is_array($d['jadwal'] ?? null)) {
                throw new RuntimeException('Jadwal tidak valid');
            }
            $keys = ['imsak', 'subuh', 'terbit', 'dhuha', 'dzuhur', 'ashar', 'maghrib', 'isya'];
            $days = [];
            foreach ($d['jadwal'] as $row) {
                $date = (string) ($row['date'] ?? '');
                if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
                    continue;
                }
                $t = [];
                foreach ($keys as $k) {
                    $v = (string) ($row[$k] ?? '');
                    if (!preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $v)) {
                        continue 2;
                    }
                    $t[$k] = $v;
                }
                $days[$date] = $t;
            }
            if (count($days) < 28) {
                throw new RuntimeException('Jadwal tidak lengkap');
            }
            ksort($days);
            $daerah = clean_text($d['daerah'] ?? '');
            return [
                'id'     => $city,
                'lokasi' => clean_text($d['lokasi'] ?? ''),
                'daerah' => $daerah,
                'tz'     => tz_offset($daerah),
                'month'  => sprintf('%04d-%02d', $year, $month),
                'days'   => $days,
            ];
        });

    send_json(['ok' => true, 'data' => $data], 200, $isPast ? 7 * 86400 : 6 * 3600);
}

function action_locate(): never
{
    rate_limit('locate', 10, 60);

    $lat = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
    $lon = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);
    // Batas kasar wilayah Indonesia.
    if ($lat === false || $lon === false || $lat < -11.5 || $lat > 6.5 || $lon < 94.5 || $lon > 141.5) {
        throw new ApiError('Lokasi berada di luar wilayah Indonesia.', 422);
    }
    // Dibulatkan (~1 km) demi privasi dan efisiensi cache.
    $lat = round($lat, 2);
    $lon = round($lon, 2);

    $addr = remember(sprintf('geo_%.2f_%.2f', $lat, $lon), 180 * 86400, static function () use ($lat, $lon): array {
        // Patuhi kebijakan Nominatim: maks. 1 request/detik.
        $gate = storage('cache') . '/nominatim.gate';
        $h = fopen($gate, 'c+');
        flock($h, LOCK_EX);
        $last = (float) stream_get_contents($h);
        $wait = 1.1 - (microtime(true) - $last);
        if ($wait > 0) {
            usleep((int) ($wait * 1e6));
        }
        ftruncate($h, 0);
        rewind($h);
        fwrite($h, (string) microtime(true));
        flock($h, LOCK_UN);
        fclose($h);

        $url = NOMINATIM_BASE . '/reverse?' . http_build_query([
            'format' => 'jsonv2', 'lat' => $lat, 'lon' => $lon,
            'zoom' => 14, 'addressdetails' => 1, 'accept-language' => 'id',
        ]);
        $res = http_get_json($url);
        $address = $res['address'] ?? null;
        if (!is_array($address)) {
            throw new RuntimeException('Alamat tidak ditemukan');
        }
        return array_map(static fn ($v) => clean_text($v), array_filter($address, 'is_string'));
    });

    $match = match_city($addr, cities());
    if (!$match) {
        throw new ApiError('Kab/kota untuk lokasi Anda belum ditemukan. Silakan pilih manual.', 404);
    }
    send_json(['ok' => true, 'data' => ['id' => $match, 'lokasi' => cities()[$match]]], 200, 0);
}

/** Cocokkan komponen alamat OSM dengan daftar kab/kota Kemenag. */
function match_city(array $addr, array $cities): ?string
{
    $order = ['city', 'town', 'county', 'municipality', 'regency', 'state_district', 'city_district', 'village', 'suburb'];
    $candidates = [];
    foreach ($order as $k) {
        if (!empty($addr[$k])) {
            $candidates[] = [$k, $addr[$k]];
        }
    }

    $index = [];
    foreach ($cities as $id => $name) {
        $index[] = ['id' => (string) $id, 'norm' => norm_region($name), 'kind' => region_kind($name)];
    }

    $pick = static function (array $hits, ?string $kind, string $field): ?string {
        if (!$hits) {
            return null;
        }
        $prefer = $kind ?? ($field === 'city' ? 'KOTA' : 'KAB');
        foreach ($hits as $h) {
            if ($h['kind'] === $prefer) {
                return $h['id'];
            }
        }
        return $hits[0]['id'];
    };

    // 1) Kecocokan persis.
    foreach ($candidates as [$field, $raw]) {
        $n = norm_region($raw);
        $hits = array_values(array_filter($index, static fn ($c) => $c['norm'] === $n));
        if ($id = $pick($hits, region_kind($raw), $field)) {
            return $id;
        }
    }
    // 2) Kecocokan sebagian per kata (mis. "Jakarta Selatan" → "Kota Jakarta").
    foreach ($candidates as [$field, $raw]) {
        $n = ' ' . norm_region($raw) . ' ';
        $hits = array_values(array_filter($index, static fn ($c) =>
            strlen($c['norm']) >= 4 && str_contains($n, ' ' . $c['norm'] . ' ')));
        usort($hits, static fn ($a, $b) => strlen($b['norm']) <=> strlen($a['norm']));
        if ($id = $pick($hits, region_kind($raw), $field)) {
            return $id;
        }
    }
    return null;
}
