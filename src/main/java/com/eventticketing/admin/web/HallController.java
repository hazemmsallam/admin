package com.eventticketing.admin.web;

import com.eventticketing.admin.client.TicketingApiException;
import com.eventticketing.admin.client.TicketingClient;
import com.eventticketing.admin.client.dto.CreateHallRequest;
import com.eventticketing.admin.client.dto.HallResponse;
import com.eventticketing.admin.client.dto.SeatBuildItem;
import com.eventticketing.admin.client.dto.SeatLayoutItem;
import com.eventticketing.admin.client.dto.SeatResponse;
import com.eventticketing.admin.client.dto.UpdateHallRequest;
import com.eventticketing.admin.client.dto.UpdateHallSeatsRequest;
import com.eventticketing.admin.client.dto.UpdateSeatLayoutRequest;
import com.eventticketing.admin.web.form.HallEditForm;
import com.eventticketing.admin.web.form.HallForm;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.validation.BindingResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseBody;
import org.springframework.web.servlet.mvc.support.RedirectAttributes;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Controller
@RequestMapping("/halls")
public class HallController {

    private final TicketingClient client;
    private final ObjectMapper objectMapper;

    public HallController(TicketingClient client, ObjectMapper objectMapper) {
        this.client = client;
        this.objectMapper = objectMapper;
    }

    @GetMapping
    public String list(Model model) {
        model.addAttribute("halls", client.listHalls());
        return "halls/list";
    }

    @GetMapping("/new")
    public String createForm(Model model) {
        model.addAttribute("hall", new HallForm());
        return "halls/form";
    }

    @PostMapping
    public String create(@Valid @ModelAttribute("hall") HallForm form, BindingResult binding,
                         Model model, RedirectAttributes ra) {
        if (binding.hasErrors()) {
            return "halls/form";
        }
        HallResponse created;
        try {
            created = client.createHall(toCreateRequest(form));
        } catch (TicketingApiException ex) {
            model.addAttribute("error", ex.getMessage());
            return "halls/form";
        }
        ra.addFlashAttribute("success", "Hall created.");
        if (created.seated()) {
            // Apply the layout the admin arranged in the builder; if none/failed, open the editor.
            boolean applied = applyBuilderLayout(created, form.getLayoutJson(), ra);
            return applied
                    ? "redirect:/halls/" + created.id()
                    : "redirect:/halls/" + created.id() + "?edit=true";
        }
        return "redirect:/halls";
    }

    @GetMapping("/{id}")
    public String view(@PathVariable Long id, Model model) {
        HallResponse hall = client.getHall(id);
        model.addAttribute("hall", hall);
        model.addAttribute("sectionsJson", writeJsonOrEmpty(hall.sections()));
        return "halls/view";
    }

    private String writeJsonOrEmpty(Object value) {
        try {
            return objectMapper.writeValueAsString(value != null ? value : java.util.List.of());
        } catch (Exception ex) {
            return "[]";
        }
    }

    @GetMapping("/{id}/edit")
    public String editForm(@PathVariable Long id, Model model) {
        HallResponse hall = client.getHall(id);
        HallEditForm form = new HallEditForm();
        form.setName(hall.name());
        form.setAddress(hall.address());
        model.addAttribute("hall", form);
        model.addAttribute("id", id);
        return "halls/edit";
    }

    @PostMapping("/{id}")
    public String update(@PathVariable Long id, @Valid @ModelAttribute("hall") HallEditForm form,
                         BindingResult binding, Model model, RedirectAttributes ra) {
        if (binding.hasErrors()) {
            model.addAttribute("id", id);
            return "halls/edit";
        }
        try {
            client.updateHall(id, new UpdateHallRequest(form.getName(), form.getAddress()));
        } catch (TicketingApiException ex) {
            model.addAttribute("id", id);
            model.addAttribute("error", ex.getMessage());
            return "halls/edit";
        }
        ra.addFlashAttribute("success", "Hall updated.");
        return "redirect:/halls";
    }

    @PostMapping("/{id}/layout")
    @ResponseBody
    public ResponseEntity<HallResponse> updateLayout(@PathVariable Long id,
                                                     @RequestBody UpdateSeatLayoutRequest request) {
        return ResponseEntity.ok(client.updateHallLayout(id, request));
    }

    @PostMapping("/{id}/seats")
    @ResponseBody
    public ResponseEntity<?> updateSeats(@PathVariable Long id,
                                         @RequestBody UpdateHallSeatsRequest request) {
        try {
            return ResponseEntity.ok(client.updateHallSeats(id, request));
        } catch (TicketingApiException ex) {
            // Surface the API's message (e.g. "Cannot delete seats that have bookings: ...").
            return ResponseEntity.badRequest().body(ex.getMessage());
        }
    }

    @PostMapping("/{id}/delete")
    public String delete(@PathVariable Long id, RedirectAttributes ra) {
        try {
            client.deleteHall(id);
            ra.addFlashAttribute("success", "Hall deleted.");
        } catch (TicketingApiException ex) {
            ra.addFlashAttribute("error", ex.getMessage());
        }
        return "redirect:/halls";
    }

    /**
     * Maps the builder's row/column-keyed seats onto the generated seat IDs and pushes them
     * to the layout endpoint. Returns true if a layout was applied. A failure here is
     * non-fatal: the hall already exists with its default layout, so the caller falls back
     * to the interactive editor.
     */
    private boolean applyBuilderLayout(HallResponse created, String layoutJson, RedirectAttributes ra) {
        if (layoutJson == null || layoutJson.isBlank()) {
            return false;
        }
        try {
            List<SeatBuildItem> builds =
                    objectMapper.readValue(layoutJson, new TypeReference<List<SeatBuildItem>>() {});
            if (builds.isEmpty()) {
                return false;
            }
            Map<String, Long> idByKey = new HashMap<>();
            for (SeatResponse seat : created.seats()) {
                idByKey.put(seat.rowIndex() + ":" + seat.seatNumber(), seat.id());
            }
            List<SeatLayoutItem> items = new ArrayList<>();
            for (SeatBuildItem b : builds) {
                Long seatId = idByKey.get(b.r() + ":" + b.c());
                if (seatId != null) {
                    items.add(new SeatLayoutItem(seatId, b.x(), b.y(), b.rot(), b.w(), b.h(),
                            blankToNull(b.section())));
                }
            }
            if (items.isEmpty()) {
                return false;
            }
            client.updateHallLayout(created.id(),
                    new UpdateSeatLayoutRequest(created.layoutWidth(), created.layoutHeight(), items));
            return true;
        } catch (Exception ex) {
            ra.addFlashAttribute("error",
                    "Hall created, but the arranged layout could not be applied: " + ex.getMessage());
            return false;
        }
    }

    private static String blankToNull(String value) {
        return (value == null || value.isBlank()) ? null : value.trim();
    }

    private CreateHallRequest toCreateRequest(HallForm form) {
        if (!form.isSeated()) {
            return new CreateHallRequest(form.getName(), form.getAddress(), false,
                    null, null, null, form.getCapacity());
        }
        return new CreateHallRequest(form.getName(), form.getAddress(), true,
                form.getNumRows(), form.getNumColumns(), null, null);
    }
}
