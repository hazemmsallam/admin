package com.eventticketing.admin.client.dto;

import java.util.List;

public record CreateHallRequest(
        String name,
        String address,
        boolean seated,
        Integer numRows,
        Integer numColumns,
        String numberingScheme,
        List<RowTypeRange> rowTypes,
        Integer capacity
) {
}
