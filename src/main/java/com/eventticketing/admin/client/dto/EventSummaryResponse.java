package com.eventticketing.admin.client.dto;

import java.time.Instant;
import java.util.Set;

public record EventSummaryResponse(
        Long id,
        String name,
        String category,
        String imageUrl,
        String tagline,
        Boolean featured,
        Set<String> tags,
        Instant startAt,
        Instant endAt,
        String status,
        Long hallId,
        String hallName,
        String hallAddress,
        boolean seated
) {
}
