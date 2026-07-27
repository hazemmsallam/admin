package com.eventticketing.admin.client.dto;

import java.util.List;

public record HallResponse(
        Long id,
        String name,
        String address,
        Integer capacity,
        boolean seated,
        Integer numRows,
        Integer numColumns,
        String numberingScheme,
        Integer layoutWidth,
        Integer layoutHeight,
        List<SeatResponse> seats,
        List<LayoutObjectResponse> layoutObjects
) {
}
